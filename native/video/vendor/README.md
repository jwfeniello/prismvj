# Vendored code for native/video

- `spout/`: SpoutDX and the SpoutGL support files it needs, from
  [Spout2](https://github.com/leadedge/Spout2) release 2.007.018
  (commit 6b68a5b4fdeca6130b851e5f9366467a844860e5), unmodified. BSD 2-Clause, see `spout/LICENSE`.
- `ndi/`: the NDI SDK 6.3 header files (`Version.txt`), unmodified, as published in
  [DistroAV](https://github.com/DistroAV/DistroAV/tree/master/lib/ndi). Each header carries NDI's
  MIT license. The NDI runtime itself is not part of PrismVJ; it is loaded at run time from the
  NDI Runtime the user installs. NDI® is a registered trademark of Vizrt NDI AB.
