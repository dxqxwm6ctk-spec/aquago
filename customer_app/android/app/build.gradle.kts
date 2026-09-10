import java.util.Properties

plugins {
    id("com.android.application")
    id("kotlin-android")
    // The Flutter Gradle Plugin must be applied after the Android and Kotlin Gradle plugins.
    id("dev.flutter.flutter-gradle-plugin")
    // لازم لـFirebase: بلا هذا لا تُقرأ google-services.json فيفشل
    // Firebase.initializeApp على الجهاز.
    id("com.google.gms.google-services")
}

/**
 * إعداد توقيع الإصدار — يُقرأ من `android/key.properties` غير المُودَع في git
 * (تحرسه قاعدة `key.properties` في .gitignore)، والملف بدوره يشير إلى
 * keystore **خارج المستودع** بمسار مطلق.
 *
 * مفتاح هذا التطبيق وحده: تطبيق السائق له مفتاحه المستقل. مفتاحٌ مشترك بين
 * التطبيقين يعني أن تسريبه يُسقط الاثنين، وأن أحدهما لا يُسلَّم لجهة أخرى دون
 * الآخر — وصلاحيات أندرويد من نوع `signature` تصير مشتركة بينهما.
 *
 * غياب الملف ليس خطأً: من يبني للتطوير وحده لا يحتاج مفتاح إصدار.
 */
val keystoreProperties = Properties().apply {
    val file = rootProject.file("key.properties")
    if (file.exists()) file.inputStream().use { load(it) }
}
val hasReleaseKeystore = keystoreProperties.getProperty("storeFile") != null

android {
    namespace = "jo.aquago.customer"
    compileSdk = flutter.compileSdkVersion
    ndkVersion = flutter.ndkVersion

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
        // يطلبه flutter_local_notifications: يستعمل java.time التي لا
        // توجد قبل API 26، فيوفّرها التحويل لأجهزة أقدم.
        isCoreLibraryDesugaringEnabled = true
    }

    kotlinOptions {
        jvmTarget = JavaVersion.VERSION_17.toString()
    }

    defaultConfig {
        // TODO: Specify your own unique Application ID (https://developer.android.com/studio/build/application-id.html).
        applicationId = "jo.aquago.customer"
        // You can update the following values to match your application needs.
        // For more information, see: https://flutter.dev/to/review-gradle-config.
        minSdk = flutter.minSdkVersion
        targetSdk = flutter.targetSdkVersion
        versionCode = flutter.versionCode
        versionName = flutter.versionName
    }

    signingConfigs {
        if (hasReleaseKeystore) {
            create("release") {
                storeFile = file(keystoreProperties.getProperty("storeFile"))
                storePassword = keystoreProperties.getProperty("storePassword")
                keyAlias = keystoreProperties.getProperty("keyAlias")
                keyPassword = keystoreProperties.getProperty("keyPassword")
            }
        }
    }

    buildTypes {
        release {
            // بلا `key.properties` يتراجع البناء إلى مفاتيح التطوير ليبقى
            // `flutter run --release` عاملاً على جهاز المطوّر. أما مخرَج
            // النشر فيُبنى بمفتاح الإصدار حتماً — والفحص أدناه يمنع رفع
            // حزمة موقّعة بمفتاح تطوير بالخطأ، وهو خطأ لا يُكتشف إلا بعد
            // رفضها من Play أو بعد نشرها بمفتاح لا يملكه أحد.
            signingConfig = if (hasReleaseKeystore) {
                signingConfigs.getByName("release")
            } else {
                signingConfigs.getByName("debug")
            }
        }
    }
}

/**
 * مخرَج النشر (`bundleRelease`) لا يُبنى بمفاتيح التطوير — يفشل صراحةً بدلها.
 *
 * الحزمة الموقّعة بمفتاح تطوير تُرفض من Play برسالة غامضة، أو — وهو الأسوأ —
 * تُنشَر بمفتاح لا يملكه أحد فيتعذّر تحديث التطبيق بعدها إلى الأبد. الفشل عند
 * البناء أرخص من اكتشاف ذلك بعد الرفع.
 *
 * `assembleRelease` لا يدخل في هذا: يُستعمل للتجربة المحلية على جهاز حقيقي.
 */
tasks.matching { it.name == "bundleRelease" }.configureEach {
    doFirst {
        if (!hasReleaseKeystore) {
            throw GradleException(
                "لا يوجد android/key.properties — حزمة النشر تحتاج مفتاح الإصدار. " +
                    "انظر docs/ANDROID_SIGNING.md",
            )
        }
    }
}

flutter {
    source = "../.."
}

dependencies {
    coreLibraryDesugaring("com.android.tools:desugar_jdk_libs:2.1.4")
}
