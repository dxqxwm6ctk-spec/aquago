import { BadRequestException } from '@nestjs/common';
import { randomBytes, scrypt, timingSafeEqual } from 'crypto';
import { promisify } from 'util';

const scryptAsync = promisify(scrypt) as (
  password: string,
  salt: Buffer,
  keylen: number,
) => Promise<Buffer>;

const KEY_LEN = 64;

/**
 * تجزئة كلمات المرور بـ scrypt من مكتبة Node القياسية — بلا اعتماديات
 * جديدة ولا بناء أصيل داخل صورة Docker. الصيغة المخزّنة: scrypt$salt$key
 */
export async function hashPassword(plain: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptAsync(plain.normalize('NFKC'), salt, KEY_LEN);
  return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`;
}

export async function verifyPassword(
  plain: string,
  stored: string | null,
): Promise<boolean> {
  if (!stored) return false;
  const [alg, saltHex, keyHex] = stored.split('$');
  if (alg !== 'scrypt' || !saltHex || !keyHex) return false;
  const expected = Buffer.from(keyHex, 'hex');
  const actual = await scryptAsync(
    plain.normalize('NFKC'),
    Buffer.from(saltHex, 'hex'),
    expected.length,
  );
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** أسماء المستخدمين تُقارن بحروف صغيرة دائماً — لا حسابان يفترقان بحالة حرف */
export function normalizeUsername(raw: string): string {
  return raw.trim().toLowerCase();
}

const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{2,31}$/;

export function assertValidUsername(raw: string): string {
  const username = normalizeUsername(raw);
  if (!USERNAME_RE.test(username)) {
    throw new BadRequestException(
      'اسم المستخدم: 3–32 حرفاً إنجليزياً صغيراً أو رقماً، ويسمح بـ . _ - (يبدأ بحرف أو رقم)',
    );
  }
  return username;
}

export function assertValidPassword(plain: string): string {
  if (typeof plain !== 'string' || plain.length < 8) {
    throw new BadRequestException('كلمة المرور يجب ألا تقل عن 8 محارف');
  }
  if (plain.length > 128) {
    throw new BadRequestException('كلمة المرور طويلة جداً');
  }
  if (!/[A-Za-z]/.test(plain) || !/[0-9]/.test(plain)) {
    throw new BadRequestException('كلمة المرور يجب أن تجمع حروفاً وأرقاماً');
  }
  return plain;
}

/**
 * كلمة المرور الأولى يولّدها النظام دائماً ولا يكتبها أحد (قرار 2026-08-02):
 * ما يكتبه بشر يكون ضعيفاً أو مكرراً، ولا يصح أن يعرف السوبر أدمن كلمات مرور
 * الوكالات. تُعرض مرة واحدة عند الإنشاء، ويُجبر صاحبها على تغييرها أول دخول.
 *
 * 12 محرفاً من مجموعات مختلطة، بلا محارف ملتبسة (0/O/1/l/I) لأنها تُملى
 * أحياناً على الهاتف، وبرموز آمنة في النسخ واللصق.
 */
export function generateTempPassword(): string {
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const lower = 'abcdefghijkmnpqrstuvwxyz';
  const digits = '23456789';
  const symbols = '@#%&*+=?';
  const rand = (set: string) => set[randomBytes(1)[0] % set.length];
  const chars = [
    ...Array.from({ length: 2 }, () => rand(upper)),
    ...Array.from({ length: 5 }, () => rand(lower)),
    ...Array.from({ length: 4 }, () => rand(digits)),
    rand(symbols),
  ];
  // خلط Fisher–Yates بعشوائية تشفيرية حتى لا يكون ترتيب المجموعات ثابتاً
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomBytes(1)[0] % (i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}
