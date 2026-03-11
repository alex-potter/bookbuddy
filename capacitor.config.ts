// Capacitor configuration — @capacitor/cli types available after: npm install
const config = {
  appId: 'com.bookbuddy.app',
  appName: 'BookBuddy',
  webDir: 'out',            // next build output directory (output:'export')
  server: {
    androidScheme: 'https', // serve bundled assets over https:// in WebView
  },
  android: {
    allowMixedContent: true, // allow HTTP calls to local Ollama/Calibre over WiFi
  },
};

export default config;
