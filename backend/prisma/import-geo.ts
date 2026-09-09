/**
 * استيراد حدود جغرافية جاهزة (GeoJSON) إلى التسلسل: مدينة ← منطقة ← حي
 *
 * الاستخدام:
 *   npm run v2:geo:import -- prisma/data/amman-districts.geojson
 *
 * صيغة الملف: FeatureCollection وكل Feature فيه:
 *   properties.city           اسم المدينة بالعربية (إلزامي)
 *   properties.cityEn         اختياري
 *   properties.district       اسم المنطقة بالعربية (إلزامي)
 *   properties.districtEn     اختياري
 *   properties.neighborhood   اسم الحي بالعربية — بدونه تُخزَّن الحدود على المنطقة
 *   properties.neighborhoodEn اختياري

 *   geometry                  Polygon أو MultiPolygon بإحداثيات WGS84
 *
 * الاستيراد idempotent: يعيد تشغيله يحدّث الحدود دون تكرار الصفوف.
 * المصدر المتوقع: geoBoundaries / OSM / بيانات أمانة رسمية — لا رسم يدوي.
 */
import { PrismaClient } from '@prisma-v2/client';
import * as fs from 'fs';

const prisma = new PrismaClient();

type Feature = {
  properties: Record<string, unknown>;
  geometry: { type: string; coordinates: unknown };
};

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

async function setGeom(table: 'District' | 'Neighborhood', id: string, geometry: object) {
  // ST_MakeValid ثم استخراج المضلعات فقط ثم ST_Multi — يقبل Polygon و MultiPolygon
  const gj = JSON.stringify(geometry);
  await prisma.$executeRawUnsafe(
    `UPDATE "${table}"
     SET geom = ST_Multi(ST_CollectionExtract(ST_MakeValid(ST_SetSRID(ST_GeomFromGeoJSON($1), 4326)), 3))
     WHERE id = $2`,
    gj,
    id,
  );
}

async function main() {
  const path = process.argv[2];
  if (!path) {
    console.error('❌ الاستخدام: npm run v2:geo:import -- <file.geojson>');
    process.exit(1);
  }
  const doc = JSON.parse(fs.readFileSync(path, 'utf8'));
  const features: Feature[] = doc.features ?? [];
  if (!features.length) {
    console.error('❌ الملف لا يحتوي features');
    process.exit(1);
  }

  let cities = 0, districts = 0, neighborhoods = 0, skipped = 0;

  for (const f of features) {
    const cityAr = str(f.properties.city);
    const districtAr = str(f.properties.district);
    const neighborhoodAr = str(f.properties.neighborhood);
    if (!cityAr || !districtAr || !f.geometry || !['Polygon', 'MultiPolygon'].includes(f.geometry.type)) {
      skipped++;
      continue;
    }

    let city = await prisma.city.findUnique({ where: { nameAr: cityAr } });
    if (!city) {
      city = await prisma.city.create({
        data: { nameAr: cityAr, nameEn: str(f.properties.cityEn) },
      });
      cities++;
    }

    const district = await prisma.district.upsert({
      where: { cityId_nameAr: { cityId: city.id, nameAr: districtAr } },
      update: {
        ...(str(f.properties.districtEn) ? { nameEn: str(f.properties.districtEn) } : {}),
      },
      create: {
        cityId: city.id,
        nameAr: districtAr,
        nameEn: str(f.properties.districtEn),
      },
    });

    if (neighborhoodAr) {
      const neighborhood = await prisma.neighborhood.upsert({
        where: { districtId_nameAr: { districtId: district.id, nameAr: neighborhoodAr } },
        update: {
          ...(str(f.properties.neighborhoodEn) ? { nameEn: str(f.properties.neighborhoodEn) } : {}),
        },
        create: {
          districtId: district.id,
          nameAr: neighborhoodAr,
          nameEn: str(f.properties.neighborhoodEn),
        },
      });
      await setGeom('Neighborhood', neighborhood.id, f.geometry as object);
      neighborhoods++;
    } else {
      await setGeom('District', district.id, f.geometry as object);
      districts++;
    }
  }

  // الفهارس المكانية (idempotent — نفس ما يضمنه الـ seed)
  await prisma.$executeRawUnsafe(
    `CREATE INDEX IF NOT EXISTS neighborhood_geom_gist ON "Neighborhood" USING GIST (geom)`,
  );
  await prisma.$executeRawUnsafe(
    `CREATE INDEX IF NOT EXISTS district_geom_gist ON "District" USING GIST (geom)`,
  );

  console.log(`✅ استيراد: ${cities} مدينة جديدة، ${districts} حدود مناطق، ${neighborhoods} حدود أحياء${skipped ? `، تخطي ${skipped}` : ''}`);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
