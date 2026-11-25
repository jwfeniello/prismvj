{
  "targets": [{
    "target_name": "prism_link",
    "sources": ["link.cc"],
    "include_dirs": ["vendor/include", "vendor/modules/asio-standalone/asio/include"],
    "defines": ["NAPI_VERSION=8", "ASIO_STANDALONE"],
    "conditions": [
      ["OS=='win'", {
        "defines": ["LINK_PLATFORM_WINDOWS=1", "_WIN32_WINNT=0x0601", "NOMINMAX"],
        "libraries": ["ws2_32.lib", "iphlpapi.lib", "winmm.lib"],
        "msvs_settings": {
          "VCCLCompilerTool": { "ExceptionHandling": 1, "AdditionalOptions": ["/bigobj"] }
        }
      }],
      ["OS=='linux'", {
        "defines": ["LINK_PLATFORM_LINUX=1"],
        "cflags_cc!": ["-fno-exceptions", "-fno-rtti"],
        "cflags_cc": ["-fexceptions"],
        "libraries": ["-lpthread"]
      }],
      ["OS=='mac'", {
        "defines": ["LINK_PLATFORM_MACOSX=1"],
        "xcode_settings": { "GCC_ENABLE_CPP_EXCEPTIONS": "YES", "GCC_ENABLE_CPP_RTTI": "YES" }
      }]
    ]
  }]
}
