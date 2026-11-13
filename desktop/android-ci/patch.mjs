// Adjusts the Android project that `tauri android init` generates (in CI):
//  - permissions UaN needs (network state for peer-to-peer, notifications),
//  - signing with UaN's release key (so updates install over the old version).
// Usage: node android-ci/patch.mjs   (run in desktop/, after `tauri android init`)
import fs from 'node:fs';

const manifest = 'gen/android/app/src/main/AndroidManifest.xml';
let m = fs.readFileSync(manifest, 'utf8');
const perms = [
  'android.permission.ACCESS_NETWORK_STATE',
  'android.permission.ACCESS_WIFI_STATE',
  'android.permission.CHANGE_WIFI_MULTICAST_STATE',
  'android.permission.POST_NOTIFICATIONS',
];
const add = perms.filter((p) => !m.includes(p)).map((p) => `    <uses-permission android:name="${p}" />`).join('\n');
if (add) {
  if (!m.includes('android.permission.INTERNET')) throw new Error('INTERNET permission line not found');
  m = m.replace(/(\s*<uses-permission android:name="android\.permission\.INTERNET"\s*\/>)/, `$1\n${add}`);
}
fs.writeFileSync(manifest, m);

const gradle = 'gen/android/app/build.gradle.kts';
let g = fs.readFileSync(gradle, 'utf8');
if (!g.includes('signingConfigs')) {
  if (!g.includes('import java.util.Properties')) g = 'import java.util.Properties\n' + g;
  if (!g.includes('import java.io.FileInputStream')) g = 'import java.io.FileInputStream\n' + g;
  const signing = `    signingConfigs {
        create("release") {
            val props = Properties()
            val file = rootProject.file("keystore.properties")
            if (file.exists()) props.load(FileInputStream(file))
            keyAlias = props["keyAlias"] as String?
            keyPassword = props["password"] as String?
            storeFile = (props["storeFile"] as String?)?.let { file(it) }
            storePassword = props["password"] as String?
        }
    }
    buildTypes {`;
  if (!/\n    buildTypes \{/.test(g)) throw new Error('buildTypes block not found');
  g = g.replace(/\n    buildTypes \{/, '\n' + signing);
  if (!/getByName\("release"\) \{/.test(g)) throw new Error('release build type not found');
  g = g.replace(/getByName\("release"\) \{/, 'getByName("release") {\n            signingConfig = signingConfigs.getByName("release")');
}
fs.writeFileSync(gradle, g);
console.log('android project patched');
