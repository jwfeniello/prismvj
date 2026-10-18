# PrismVJ architecture

Windows desktop performance application based on the behavior in the supplied Resolume 4 manual. The full manual scope is tracked in REQUIREMENTS.md; initial implementation is not a claim of complete parity.

Electron provides isolated native file dialogs, atomic project writes, recovery, media URLs, display output, and OSC networking. The renderer uses ES modules, WebGL2 compositing, HTML media decoding and Web Audio. No remote application content is loaded.

## Shared contract

`src/model.js` exports `createProject()`, `createLayer(name)`, `createClip(kind, options)`, `validateProject(input)`, `serializeProject(project)`, `crossfadeGain(group, value)`, and `Transport`.

Project: `{version:1,id,name,width:1280,height:720,bpm:120,masterOpacity:1,masterVolume:1,crossfader:0.5,speed:1,paused:false,blackout:false,quantize:0,selectedDeckId,decks:[{id,name}],layers:[],effects:[],mappings:[],output:{}}`.
Layer: `{id,name,opacity:1,volume:1,blend:'normal',group:'none',bypass:false,solo:false,transition:0,autoPilot:'off',clips:{[deckId]:[clip|null,...]},activeClipId:null,effects:[]}`.
Clip: `{id,name,kind:'video'|'audio'|'image'|'source',path:'',url:'',source:'plasma'|'grid'|'rings'|'noise'|'solid',color:'#ff6a38',duration:8,speed:1,direction:1,loop:'loop'|'once'|'pingpong'|'random',beatSync:false,beats:16,inPoint:0,outPoint:1,opacity:1,volume:1,scale:1,x:0,y:0,rotation:0,trigger:'restart'|'continue'|'piano',cues:[0,0.25,0.5,0.75],effects:[]}`. `inPoint/outPoint/cues` normalized 0..1, rotation degrees, x/y normalized to canvas.
Effect: `{id,type,enabled:true,amount:0.5}`. First effects: invert, grayscale, brightness, contrast, saturation, hue, pixelate, mirror, kaleidoscope, strobe.

`Transport` API: `trigger(layerId,clipId,nowSeconds)`, `stop(layerId)`, `seek(layerId,normalized)`, `tick(nowSeconds)` returning array `{layer,clip,position,time,weight}`; `project` property may be replaced on load. Position normalized full duration, time seconds. Trigger consults project's current deck across all decks; switching decks preserves active playback. Clock is monotonic seconds. `tick` handles queued quantization, speed, direction, loop/in/out/beatSync/transition/autopilot. Pause freezes clock without catchup. `getState(layerId)` optional.

`src/engine.js` exports `LiveEngine`. `new LiveEngine(canvas,{onError:(message)=>{}})`, `await engine.prepare(clip)` loads media (called at import/trigger); `engine.render(project,frames,nowSeconds)` displays and synchronizes media; `engine.resize(width,height)`, `engine.getMedia(clipId)`, `engine.remove(clipId)`, `engine.dispose()`. `engine.audioContext`, `engine.recordingStream()` for canvas+audio capture; `engine.getStats()`. `prepare` uses `clip.url || clip.path`. Clip position is driven by Transport; forward timeline media playback sync rather than per-frame seeking. Paused/reverse/scrub may seek. Generated sources require no file. Shader layers bottom to top (project.layers[0] bottom). Effects apply clip then layer then composition. Resource cleanup and context loss recovery required.

`window.desktop` from preload: `importMedia()` -> array `{name,path,url,kind}`, `saveProject(project,saveAs)` -> `{path}|null`, `openProject()` -> `{project,path}|null`, `recoverProject()` -> project|null, `autosave(project)` -> bool, `getDisplays()` -> array `{id,label,width,height}`, `openOutput(displayId)` -> bool, `closeOutput()`, `saveRecording(arrayBuffer)` -> path|null, `onControl(callback)` -> unsubscribe. Output window receives frames through BroadcastChannel `prism-output` with transferable image bitmaps where available; editor publishes only when output requested.

UI stores project references, uses Transport, manages editor panels and file imports. Browser mode fallback stores projects in localStorage and imports via object URLs. Electron save format stores stable absolute media paths and regenerates URLs on open. Validation is strict about structure and bounds, ignores unknown fields safely, and limits counts/resources.
