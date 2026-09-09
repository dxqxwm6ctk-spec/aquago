import 'package:flutter/material.dart';

void main() {
  runApp(const MyApp());
}

/// مشروع Flutter الأصلي لمستودع AquaGo — لم يعد يحمل شاشات فعلية:
/// تطبيقا الزبون والسائق صارا مشروعين مستقلين (`../customer_app`،
/// `../driver_app`) طبقًا لنمط SKILL.md، ولوحات الإدارة (المالك،
/// المنصة، الوكالة) صارت صفحات ويب تحت `web_admin/`.
///
/// يُترك هذا المشروع كهيكل فارغ ريثما يُقرَّر حذفه أو إعادة استخدامه.
class MyApp extends StatelessWidget {
  const MyApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'AquaGo',
      theme: ThemeData(
        colorScheme: ColorScheme.fromSeed(seedColor: const Color(0xFF06B6D4)),
      ),
      home: const Scaffold(
        body: Center(child: Text('AquaGo')),
      ),
    );
  }
}
