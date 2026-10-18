{
  "targets": [{
    "target_name": "prism_link",
    "sources": ["link.cc"],
    "include_dirs": ["vendor/include", "vendor/modules/asio-standalone/asio/include"],
    "defines": ["NAPI_VERSION=8", "LINK_PLATFORM_WINDOWS=1", "_WIN32_WINNT=0x0601", "NOMINMAX", "ASIO_STANDALONE"],
    "libraries": ["ws2_32.lib", "iphlpapi.lib", "winmm.lib"],
    "msvs_settings": {
      "VCCLCompilerTool": { "ExceptionHandling": 1, "AdditionalOptions": ["/bigobj"] }
    }
  }]
}
