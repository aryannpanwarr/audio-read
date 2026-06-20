package com.audioreadnative

import android.app.Application
import com.facebook.react.PackageList
import com.facebook.react.ReactApplication
import com.facebook.react.ReactHost
import com.facebook.react.ReactNativeApplicationEntryPoint.loadReactNative
import com.facebook.react.defaults.DefaultReactHost.getDefaultReactHost
import com.audioreadnative.tts.KokoroTtsPackage

class MainApplication : Application(), ReactApplication {

  override val reactHost: ReactHost by lazy {
    getDefaultReactHost(
      context = applicationContext,
      packageList =
        PackageList(this).packages.apply {
          // Packages that cannot be autolinked yet can be added manually here, for example:
          add(KokoroTtsPackage())
        },
    )
  }

  override fun onCreate() {
    super.onCreate()
    LogStore.init(this)
    LogStore.installCrashHandler()
    LogStore.write("app", "before-load-react-native")
    loadReactNative(this)
    LogStore.write("app", "after-load-react-native")
  }
}
