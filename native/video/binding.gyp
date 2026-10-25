{
  "targets": [{
    "target_name": "prism_video",
    "sources": [
      "prism_video.cc",
      "vendor/spout/SpoutDX.cpp", "vendor/spout/SpoutDirectX.cpp", "vendor/spout/SpoutSenderNames.cpp",
      "vendor/spout/SpoutFrameCount.cpp", "vendor/spout/SpoutCopy.cpp", "vendor/spout/SpoutUtils.cpp",
      "vendor/spout/SpoutSharedMemory.cpp"
    ],
    "include_dirs": ["vendor/spout", "vendor/ndi"],
    "defines": ["NAPI_VERSION=8", "NOMINMAX", "_CRT_SECURE_NO_WARNINGS"],
    "msvs_settings": {
      "VCCLCompilerTool": { "ExceptionHandling": 1, "AdditionalOptions": ["/std:c++17"] }
    }
  }]
}
