/**
 * كاشف بذاءة بسيط لحقول عناوين التوصيل (عربي وإنجليزي) — تطبيع لكل كلمة
 * على حدة (لا للنص كله دفعة واحدة، حتى لا يلتصق سطران بريئان فيُنتج التصاق
 * حروفهما تطابقاً وهمياً)، ثم مطابقة كجزء من الكلمة المطبَّعة. ليس فلتراً
 * لا يُخترق — هدفه ردع الإدخال المسيء المعتاد في خانة عنوان، لا محادثة حرة.
 */

const ARABIC_BLOCKLIST = [
  'كس', 'كسم', 'شرموط', 'شرموطه', 'شرموطة', 'قحبه', 'قحبة', 'عاهره', 'عاهرة',
  'زانيه', 'زانية', 'منيوك', 'منيوكه', 'خول', 'لواط', 'زبي', 'زب', 'طيز',
  'نيك', 'نياك', 'ينيك', 'متناك', 'كلب', 'حمار', 'خرا', 'خره', 'وسخ', 'قذر',
  'حقير', 'ابن الكلب', 'ابن كلب', 'يلعن', 'لعنه', 'لعنة', 'عرص', 'قواد',
  'منيك', 'ملعون', 'حيوان', 'غبي', 'احمق', 'أحمق',
];

const ENGLISH_BLOCKLIST = [
  'fuck', 'shit', 'bitch', 'bastard', 'asshole', 'ass', 'dick', 'pussy',
  'cunt', 'slut', 'whore', 'faggot', 'nigger', 'nigga', 'motherfucker',
  'cock', 'dumbass', 'jackass', 'retard', 'idiot', 'stupid',
];

function normalizeToken(raw: string): string {
  return raw
    .toLowerCase()
    // استبدالات شائعة للالتفاف على الفلاتر (a$$ ← ass، sh1t ← shit)
    .replace(/[@]/g, 'a')
    .replace(/0/g, 'o')
    .replace(/[1!]/g, 'i')
    .replace(/3/g, 'e')
    .replace(/\$/g, 's')
    // تطبيع عربي: إزالة التشكيل/التطويل وتوحيد صور الحروف المتقاربة
    .replace(/[ً-ٰٟ]/g, '')
    .replace(/ـ+/g, '')
    .replace(/[إأآا]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/[ؤئ]/g, 'ي')
    // ما تبقى: حروف عربية/إنجليزية فقط داخل الكلمة نفسها
    .replace(/[^a-z؀-ۿ]/g, '');
}

export function containsProfanity(text: string | null | undefined): boolean {
  if (!text) return false;
  const words = text.split(/\s+/).filter(Boolean);
  return words.some((w) => {
    const n = normalizeToken(w);
    if (!n) return false;
    return (
      ARABIC_BLOCKLIST.some((bad) => n.includes(bad)) ||
      ENGLISH_BLOCKLIST.some((bad) => n.includes(bad))
    );
  });
}
