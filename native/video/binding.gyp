{
  "targets": [{
    "target_name": "prism_video",
    "sources": ["prism_video.cc"],
    "include_dirs": ["vendor/ndi"],
    "defines": ["NAPI_VERSION=8"],
    "conditions": [
      ["OS=='win'", {
        "sources": [
          "vendor/spout/SpoutDX.cpp", "vendor/spout/SpoutDirectX.cpp", "vendor/spout/SpoutSenderNames.cpp",
          "vendor/spout/SpoutFrameCount.cpp", "vendor/spout/SpoutCopy.cpp", "vendor/spout/SpoutUtils.cpp",
          "vendor/spout/SpoutSharedMemory.cpp"
        ],
        "include_dirs": ["vendor/spout"],
        "defines": ["NOMINMAX", "_CRT_SECURE_NO_WARNINGS"],
        "msvs_settings": {
          "VCCLCompilerTool": { "ExceptionHandling": 1, "AdditionalOptions": ["/std:c++17"] }
        }
      }],
      ["OS=='linux'", {
        "cflags_cc!": ["-fno-exceptions"],
        "cflags_cc": ["-fexceptions"],
        "libraries": ["-ldl", "-lpthread"]
      }],
      ["OS=='mac'", {
        "xcode_settings": { "GCC_ENABLE_CPP_EXCEPTIONS": "YES", "CLANG_CXX_LANGUAGE_STANDARD": "c++17" }
      }]
    ]
  }]
}
