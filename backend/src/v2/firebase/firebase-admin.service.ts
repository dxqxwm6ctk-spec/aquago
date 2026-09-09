import { Injectable, Logger } from '@nestjs/common';
import * as admin from 'firebase-admin';

/**
 * تهيئة Firebase Admin SDK — نسخة مشتركة بين إشعارات Push (FcmService)
 * والتحقق من تسجيل الدخول برقم الهاتف (AuthV2Service)، حتى لا يتكرر فك
 * FIREBASE_SERVICE_ACCOUNT_BASE64 في مكانين. الحارس على admin.apps.length
 * صالح عالمياً بغض النظر عن كم خدمة تنادي ensureInitialized().
 */
@Injectable()
export class FirebaseAdminService {
  private readonly logger = new Logger(FirebaseAdminService.name);

  ensureInitialized() {
    if (admin.apps.length) return;
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64;
    // الرسائل صريحة عمداً: بلا هذا كان الغياب يظهر كـ"Unexpected token" من
    // JSON.parse، والترميز الخاطئ كذلك — خطأ يشير إلى المكان الخطأ تماماً.
    if (!raw) {
      throw new Error(
        'FIREBASE_SERVICE_ACCOUNT_BASE64 غير معرَّف — لا Firebase Admin ولا إشعارات Push',
      );
    }
    let parsed: admin.ServiceAccount & {
      project_id?: string;
      client_email?: string;
      private_key?: string;
    };
    try {
      parsed = JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
    } catch {
      throw new Error(
        'FIREBASE_SERVICE_ACCOUNT_BASE64 ليس JSON صالحاً بعد فك base64 — أعد ترميز ملف حساب الخدمة كاملاً',
      );
    }
    // snake_case هو ما يكتبه ملف حساب الخدمة، وcert يقبل الصيغتين.
    const projectId = parsed.project_id ?? parsed.projectId;
    if (!projectId || !(parsed.client_email ?? parsed.clientEmail)) {
      throw new Error(
        'حساب خدمة Firebase ناقص (project_id/client_email) — تأكد أنه ملف حساب الخدمة لا ملف إعداد التطبيق',
      );
    }
    if (!(parsed.private_key ?? parsed.privateKey)?.includes('BEGIN PRIVATE KEY')) {
      throw new Error(
        'المفتاح الخاص في حساب خدمة Firebase مفقود أو مشوَّه — غالباً ضاعت أسطر \n عند نسخه',
      );
    }
    admin.initializeApp({ credential: admin.credential.cert(parsed) });
    this.logger.log(`Firebase Admin مُهيَّأ — مشروع ${projectId}`);
  }

  auth(): admin.auth.Auth {
    this.ensureInitialized();
    return admin.auth();
  }
}
