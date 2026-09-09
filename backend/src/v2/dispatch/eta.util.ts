import { haversineKm } from './geo.util';

/**
 * تقدير زمن وصول السائق إلى الزبون.
 *
 * **تقدير لا وعد.** لا محرك توجيه في المنظومة (لا Google Directions ولا
 * OSRM)، فالحساب هنا مسافة خط مستقيم مضروبة بمعامل تعرّج الطرق، على متوسط
 * سرعة مدينة. لا يعرف ازدحاماً ولا إشارة ولا طريقاً مغلقاً. الدقة الحقيقية
 * تحتاج خدمة توجيه بحركة مرور حيّة — وحين تتوفر تُستبدل هذه الدالة وحدها
 * لأن الحساب كله محصور فيها.
 */

/** الطريق أطول من الخط المستقيم — نسبة عملية للمدن العربية المتشابكة */
const ROAD_FACTOR = 1.35;

/** متوسط سرعة عملية داخل عمّان بما فيها التوقفات */
const CITY_SPEED_KMH = 25;

/** تحميل القوارير من المستودع قبل الانطلاق */
const HANDLING_MINUTES = 8;

/** حد أدنى معلن: «أقل من دقيقتين» أصدق من «صفر» */
const MIN_MINUTES = 2;

export interface EtaInput {
  status: string;
  deliveryLat: number;
  deliveryLng: number;
  driverLat?: number | null;
  driverLng?: number | null;
  /** مستودع الوكالة — يمرّ به السائق قبل الاستلام */
  branchLat?: number | null;
  branchLng?: number | null;
}

export interface EtaResult {
  minutes: number;
  distanceKm: number;
  /** يعبر المستودع أولاً؟ يفسّر للزبون لماذا الوقت أطول مما يوحي القرب */
  viaWarehouse: boolean;
}

/**
 * null حين لا يمكن التقدير: لا موقع للسائق، أو الطلب في حالة لا معنى
 * للوصول فيها (لم يُعيَّن سائق بعد، أو انتهى الطلب).
 */
export function estimateEta(input: EtaInput): EtaResult | null {
  const { status, driverLat, driverLng } = input;
  if (driverLat == null || driverLng == null) return null;
  if (!['DRIVER_ASSIGNED', 'PICKED_UP', 'DELIVERING'].includes(status)) {
    return null;
  }

  // قبل الاستلام يمرّ السائق بالمستودع، فالمسار مرحلتان لا واحدة — وتجاهل
  // ذلك كان سيعد الزبون بوقت أقصر بكثير مما سيحدث
  const viaWarehouse =
    status === 'DRIVER_ASSIGNED' &&
    input.branchLat != null &&
    input.branchLng != null;

  const km = viaWarehouse
    ? haversineKm(driverLat, driverLng, input.branchLat!, input.branchLng!) +
      haversineKm(input.branchLat!, input.branchLng!, input.deliveryLat, input.deliveryLng)
    : haversineKm(driverLat, driverLng, input.deliveryLat, input.deliveryLng);

  const drive = (km * ROAD_FACTOR) / CITY_SPEED_KMH * 60;
  const minutes = Math.max(
    MIN_MINUTES,
    Math.ceil(drive + (viaWarehouse ? HANDLING_MINUTES : 0)),
  );
  return { minutes, distanceKm: Math.round(km * 10) / 10, viaWarehouse };
}
