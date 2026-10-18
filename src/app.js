import './style.css';
import './ui/ui.css';
import './fx/builtins.js';
import { createProject, createLayer, createClip, validateProject, serializeProject, Transport, LIMITS } from './model.js';
import { listEffects, listAudioEffects, listSources, effectDefinition, audioEffectDefinition, sourceDefinition, registerEffect, registerSource, compositionFeed } from './fx/registry.js';
import { defaultParams } from './fx/shader-template.js';

import { Animator, BPM_SPEEDS } from './animation.js';
import { applyAnimations } from './automation.js';
import { PROPERTY_PARAMS, resolvePath, readOwner } from './params.js';
import { effectStackHTML, bindEffectStacks, sourceParamsHTML, cogButton, refreshAnimatedControls, readPresets, applyPreset } from './ui/param-controls.js';
import { animationMenuItems, decorateAnimations, updateAnimationStrips, inOutBarHTML, bindInOutBar } from './ui/animation-strip.js';
import { ShortcutManager } from './ui/shortcuts.js';
import { registerProjectExtension } from './model.js';
import { normalizeOutputConfig, screenFromComposition } from './output/output-model.js';
import { evaluateExpression } from './expression.js';
import { OutputWindows, routedSources } from './output/windows.js';
import { Thumbnailer } from './thumbnails.js';
import { TimecodeInput, clipTimeFromTimecode, parseTimecode, formatTimecode, timecodeToSeconds } from './smpte.js';
import { normalizeDmxConfig, sampleFixtures, fixtureSampleRect } from './dmx.js';

// Advanced Output and DMX settings are saved with the composition.
registerProjectExtension('advancedOutput', (value, owner) => normalizeOutputConfig(value, { compositionWidth: owner.width, compositionHeight: owner.height }));
registerProjectExtension('dmx', value => normalizeDmxConfig(value));
import { LiveEngine } from './engine.js';
import { applyOSC } from './controls.js';
import * as composition from './composition.js';
import { FilesBrowser } from './files-browser.js';
import { blendOptions, numericField, transformFields, componentFields, compositionSettings } from './inspector-fields.js';
import { readPreferences, writePreferences } from './preferences.js';
import { DASHBOARD_PARAMETERS, assignDashboard, moveDashboard, syncDashboard } from './dashboard.js';
import { visibleSlot, visibleClips, setPersistent } from './persistent-clips.js';
import { installResizableLayout } from './layout.js';

const $ = (selector, parent = document) => parent.querySelector(selector);
const $$ = (selector, parent = document) => [...parent.querySelectorAll(selector)];
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const clipThumbnail = clip => {
  if (clip?.thumbnail) return `<img src="${clip.thumbnail}" alt="" loading="lazy">`;
  if (!clip?.url) return '';
  const mov = clip.kind === 'video' && /\.mov$/i.test(clip.path || '') && /^prism-media:/i.test(clip.url);
  if (clip.kind !== 'image' && !mov) return '';
  const url = mov ? `${clip.url}${clip.url.includes('?') ? '&' : '?'}thumbnail=1` : clip.url;
  return `<img src="${esc(url)}" alt="" loading="lazy">`;
};
const id = () => crypto.randomUUID();
const now = () => performance.now() / 1000;
const desktop = window.desktop;

let preferences=readPreferences();
let project = createProject();
let transport = new Transport(project);
let selectedLayerId = project.layers.at(-1)?.id;
let selectedClipId = project.layers.at(-1)?.activeClipId || null;
let selectedColumn=0, clipClipboard=null, fileBrowser;
const selectedClips=new Set();
let inspectorTab = 'clip', contextTab = 'composition', browserTab = 'sources';
let effectScope = 'clip';
const collapsedSections = new Set();
let engine, dirty = false, saveTimer, recorder, recordChunks = [], recordingStarted = 0;
let outputOpen = false, sendingFrame = false, lastOutputFrame = 0;
let tapTimes = [], preview = null, midiAccess = null, learning = null;
let undoStack = [], redoStack = [], lastHistory = '', toastTimer;
const mediaLibrary = [];
const objectURLs = new Set();
const heldKeys = new Map();
const triggerRequests = new Map();
const mediaPreparations = new Map();
const heldPointers = new Map();
const oscHolds = new Map();
let pendingDashboardDrag=null;
const animator=new Animator();
let showRemaining=false,historyTimer=null;
const PLAYMODES=[['loop','⟳','Loop'],['pingpong','⇄','Ping pong'],['random','⚄','Random'],['once-clear','⏏','Play once and eject'],['once','⇥','Play once and hold']];
// Inline animation strips (see ui/animation-strip.js).
const inspectorHosts=[];
const animationContext={getProject:()=>project,animator,spectrum:source=>spectrumFor(source),
  pixelScale:key=>key==='x'?project.width:project.height,
  changed:(structural,{keepPanels=false}={})=>{changed(structural?true:'coalesce');if(structural&&!keepPanels)renderInspector();}};
let animatedCount=0,lastAnimationRefresh=0,lastFeedback=0,lastFrameTime=0,effectSearch='',sourceSearch='',selectedGroupId=null,refreshQueued=false;
const shortcutHolds=new Map();
let timecode=null,lastTimecodeLabel='';
// Ableton Link session as last reported by the main process.
let link={available:false,enabled:false,peers:0,tempo:0,playing:false,receivedAt:0,beat:0,quantum:4},lastLinkTempo=0,lastLinkPlaying=null;
let shortcuts,thumbnailer=null,lastColumn=-1,outputs=null,effectKind='video',captureDevices=[],outputEditor=null,displaysCache=[],lastDmx=0,dmxActive=false,lastOscOut=0;
const oscSent=new Map();
let lastPaint=0,paintFrames=0,paintStart=0,lastActive='';
const layerPlayheads=new Map(),clipPlayheads=new Map(),queuedSlots=new Map();
let inspectorPlayhead=null,inspectorTime=null;
const snapshot = () => JSON.stringify(validateProject(project));


function initialize() {
  $('#app').innerHTML = `
    <header class="topbar"><div class="brand">PrismVJ</div><input type="text" class="project-title" id="project-name" aria-label="Composition name" value="${esc(project.name)}"><span class="pill" id="save-state">LOCAL SESSION</span><div class="spacer"></div><button id="new-project">New</button><button id="open-project">Open</button><button id="save-project">Save</button><div class="divider"></div><button id="record">● Record</button><button id="output" class="primary">Output</button><button id="preferences" title="Preferences">Settings</button><button id="help" title="Keyboard shortcuts">?</button></header>
    <div class="toolbar"><label>BPM</label><input id="bpm" class="tempo" type="number" min="20" max="300" step=".1" value="${project.bpm}" aria-label="Tempo"><button id="tap" class="icon-btn">Tap</button><button id="link" class="icon-btn link-button" title="Ableton Link: sync tempo and beat with other apps on the network. Right-click for options." hidden>Link</button><button id="resync" class="icon-btn" title="Resync beat clock">↻</button><div class="divider"></div><label>Quantize</label><select id="quantize" aria-label="Trigger quantization"><option value="0">Immediate</option><option value=".25">¼ beat</option><option value="1">1 beat</option><option value="4">1 bar</option><option value="8">2 bars</option></select><div class="divider"></div><button data-global-direction="backward" class="icon-btn" title="Reverse all active clips; right-click to pin">◀</button><button data-global-direction="forward" class="icon-btn" title="Forward all active clips; right-click to pin">▶</button><button data-global-direction="random" class="icon-btn" title="Random playback; right-click to pin">R</button><button id="pause" class="icon-btn" title="Pause composition; right-click to pin paused clip launches">Ⅱ Pause</button><label>Speed</label><input id="global-speed" aria-label="Global speed" type="range" min=".1" max="4" step=".01" value="1"><output id="speed-value">1.00×</output><div class="spacer"></div><button id="bypass-all" class="icon-btn">Bypass all</button><button id="clear-all" class="icon-btn">Clear all</button><button id="blackout" class="icon-btn">Blackout</button></div>
    <section class="workspace"><div class="layer-label row"><span class="muted">Composition</span><button id="previous-column" class="icon-btn" title="Trigger previous column" aria-label="Trigger previous column">◀</button><button id="next-column" class="icon-btn" title="Trigger next column" aria-label="Trigger next column">▶</button><div class="spacer"></div><button id="insert-layer" class="icon-btn" title="Insert layer below selected">↧</button><button id="add-layer" class="icon-btn" title="Add layer">+</button></div><div id="column-viewport"><div id="column-heads" class="column-heads"></div></div><div id="layer-bank" class="layer-bank"></div></section>
    <nav class="deckbar"><div class="crossfade"><button id="cross-a" title="Fade to A">A</button><input id="crossfader" type="range" min="0" max="1" step=".001" value=".5" aria-label="Crossfader"><button id="cross-b" title="Fade to B">B</button></div><div id="decks" class="row"></div><button id="add-deck" class="icon-btn" title="Add deck">+</button><button id="deck-actions" class="icon-btn" title="Edit selected deck">Deck…</button><button id="column-actions" class="icon-btn" title="Edit columns">Columns…</button><span class="spacer"></span><button id="copy-clip" class="icon-btn" title="Copy selected clip (Ctrl+C)">Copy</button><button id="cut-clip" class="icon-btn" title="Cut selected clip (Ctrl+X)">Cut</button><button id="paste-clip" class="icon-btn" title="Paste into selected slot (Ctrl+V)">Paste</button></nav>
    <div class="layout-splitter horizontal" data-layout-splitter="workspace" role="separator" aria-label="Resize top and bottom sections" aria-orientation="horizontal" tabindex="0"></div>
    <main class="bottom"><section class="monitor-panel"><div class="panel-title"><span id="monitor-label">Composition Monitor</span><span id="frame-count" class="muted">60 FPS</span></div><div class="monitor-wrap"><canvas id="output-canvas" width="1280" height="720"></canvas></div><div class="monitor-caption"><span id="live-label">Composition</span><span id="resolution">1280 × 720</span></div><div class="layout-splitter horizontal" data-layout-splitter="monitors" role="separator" aria-label="Resize composition and preview monitors" aria-orientation="horizontal" tabindex="0"></div><div class="panel-title preview-title"><span>Preview Monitor</span><button id="preview-toggle" title="Preview selected clip">Preview selected</button></div><div id="preview-wrap" class="monitor-wrap preview-wrap"><span class="preview-empty">Click a clip name to preview</span></div><div class="monitor-caption"><span id="preview-label">Preview · No clip selected</span></div><div class="monitor-footer"><label>Video</label><input id="master-opacity" type="range" min="0" max="1" step=".01" value="1" aria-label="Master video"><label>Audio</label><input id="master-volume" type="range" min="0" max="1" step=".01" value="1" aria-label="Master audio"><span id="audio-meter">—</span></div></section>
    <div class="layout-splitter vertical" data-layout-splitter="panel-0" role="separator" aria-label="Resize monitor and composition panels" aria-orientation="vertical" tabindex="0"></div>
    <section class="inspector-panel context-panel"><div class="transport-tabs"><button data-inspector="composition">Composition</button><button data-inspector="layer">Layer</button><button data-inspector="group">Group</button></div><div data-inspector-panel="context" class="inspector-content"></div></section>
    <div class="layout-splitter vertical" data-layout-splitter="panel-1" role="separator" aria-label="Resize composition and clip panels" aria-orientation="vertical" tabindex="0"></div>
    <section class="inspector-panel clip-panel"><div class="transport-tabs"><button data-inspector="clip" class="active">Clip</button></div><div data-inspector-panel="clip" class="inspector-content"></div></section>
    <div class="layout-splitter vertical" data-layout-splitter="panel-2" role="separator" aria-label="Resize clip and browser panels" aria-orientation="vertical" tabindex="0"></div>
    <section class="browser-panel"><div class="browser-tabs"><button data-browser="files">Files</button><button data-browser="effects">Effects</button><button data-browser="sources" class="active">Sources</button><button data-browser="controls">Control</button></div><div id="browser" class="browser-content"></div></section></main>
    <footer class="statusbar"><span class="status-dot"></span><span id="status-text">Ready</span><span class="spacer"></span><span id="timecode-status" hidden></span><span id="memory-status"></span><span id="beat-status">BEAT 1.1</span><span>PRISMVJ 0.1</span></footer>`;
  $('.deckbar').after($('[data-layout-splitter="workspace"]'),$('.toolbar'));
  installResizableLayout($('#app'));
  inspectorHosts.push(...$$('[data-inspector-panel]'));
  const snapshotButton=document.createElement('button');snapshotButton.id='snapshot-output';snapshotButton.textContent='Snapshot';snapshotButton.title='Save the current output as PNG';$('#record').before(snapshotButton);
  engine = new LiveEngine($('#output-canvas'), {onError: message => toast(message, true)});
  prewarmCatalog();
  // A thumbnail is cached presentation, not an edit: patch the slot image in place.
  thumbnailer=new Thumbnailer({onThumbnail:(clip,thumbnail)=>{
    if(!findClip(clip.id))return;
    clip.thumbnail=thumbnail;
    for(const art of $$(`[data-clip="${CSS.escape(clip.id)}"] .clip-art`)){const image=art.querySelector('img')||art.insertBefore(document.createElement('img'),art.firstChild);image.alt='';image.src=thumbnail;}
  }});
  requestThumbnails();
  outputs=new OutputWindows({source:$('#output-canvas'),desktop,engine,onError:message=>toast(message,true),onClosed:()=>{outputOpen=outputs.active;$('#output').classList.toggle('active',outputOpen);}});
  desktop?.onDMXInput?.(({universe,data})=>shortcuts.handleDmx(universe,data));
  engine.captureProvider={screen:async params=>{if(desktop?.selectCaptureSource)await desktop.selectCaptureSource(params.device||'');return navigator.mediaDevices.getDisplayMedia({video:true,audio:false});}};
  shortcuts=new ShortcutManager({getProject:()=>project,toast,runAction,targetFor,actionState,retarget,
    changed:(structural)=>{changed(structural);if(structural&&browserTab==='controls')renderBrowser();else if(!structural)scheduleRefresh();},
    onEditChange:()=>{if(browserTab==='controls')renderBrowser();},onDevicesChange:()=>{if(browserTab==='controls')renderBrowser();},
    onRawMidi:data=>midiMessage({data}),onClockBPM:bpm=>{project.bpm=bpm;if(document.activeElement!==$('#bpm'))$('#bpm').value=bpm;},onClockStart:()=>transport.resync(now())});
  shortcuts.clock.enabled=preferences.midiClockSync;
  if(preferences.midiClockSync)shortcuts.enableMidi().catch(()=>{});
  if(preferences.smpteInputDevice)startTimecode();
  setupLink();
  if(preferences.audioInputDevice)engine.setExternalAudioInput(preferences.audioInputDevice).catch(error=>toast(`External audio input unavailable: ${error.message}`,true));
  fileBrowser=new FilesBrowser({desktop,onImport:item=>item?placeMedia(item,currentLayer()):importFiles(),onPreview:item=>startPreview(createClip(item.kind,item)),onRelink:relinkAll,onError:message=>toast(message,true)});
  bindStatic();
  applyPreferences();
  renderAll();
  if(currentClip())startPreview(currentClip());
  lastHistory = snapshot();
  transport.tick(now());
  requestAnimationFrame(frame);
  recoverAvailable();
  desktop?.onControl(message => applyControl(message));
  desktop?.onOutputState(value=>{outputOpen=value;$('#output').classList.toggle('active',value);});
  desktop?.onWarning(message=>toast(message,true));
  desktop?.onOSCError(message=>toast(message,true));
  desktop?.onMediaProgress?.(showMediaPreparation);
  window.addEventListener('error', e => toast(e.message, true));
  window.addEventListener('unhandledrejection', e => {toast(e.reason?.message || String(e.reason),true);e.preventDefault();});
}

function currentLayer(){return project.layers.find(l=>l.id===selectedLayerId)||project.layers[0];}
function findClip(clipId){for(const layer of project.layers)for(const clips of Object.values(layer.clips))for(const clip of clips)if(clip?.id===clipId)return {clip,layer};return null;}
function currentClip(){return findClip(selectedClipId)?.clip;}
function playingLayerFor(clipId){return project.layers.find(layer=>layer.id===selectedLayerId&&layer.activeClipId===clipId)||project.layers.find(layer=>layer.activeClipId===clipId);}
function storedClipList(layer,deckId=project.selectedDeckId){return layer.clips[deckId] ||= Array(project.columns||8).fill(null);}
function clipList(layer){return visibleClips(project,layer,project.selectedDeckId);}
function selectClip(layer,clip,column,extend=false){
  const oldLayer=selectedLayerId,oldColumn=selectedColumn;
  selectedLayerId=layer.id;selectedClipId=clip?.id||null;
  if(column!==undefined)selectedColumn=column;
  else if(clip){const index=clipList(layer).findIndex(item=>item?.id===clip.id);if(index>=0)selectedColumn=index;}
  if(!extend)selectedClips.clear();
  if(extend&&oldLayer===layer.id){for(let i=Math.min(oldColumn,selectedColumn);i<=Math.max(oldColumn,selectedColumn);i++){const item=clipList(layer)[i];if(item)selectedClips.add(item.id);}}
  else if(clip)selectedClips.add(clip.id);
  inspectorTab='clip';renderLayers();renderInspector();
}
function toast(message,error=false){const old=$('.toast');old?.remove();const el=document.createElement('div');el.className='toast'+(error?' error':'');el.textContent=message;el.setAttribute('role','status');document.body.append(el);clearTimeout(toastTimer);toastTimer=setTimeout(()=>el.remove(),6500);$('#status-text').textContent=message;}
function showMediaPreparation(item){
  const key=item.path||item.name;
  if(item.phase==='ready'||item.phase==='error')mediaPreparations.delete(key);
  else mediaPreparations.set(key,item);
  let panel=$('#media-preparation');
  if(!mediaPreparations.size){
    panel?.remove();
    if(item.phase==='ready')$('#status-text').textContent=`Ready: ${item.name}`;
    return;
  }
  if(!panel){
    panel=document.createElement('aside');panel.id='media-preparation';panel.className='media-preparation';
    panel.innerHTML='<span role="status" aria-live="polite"></span><progress max="1" aria-label="Media preparation"></progress>';
    document.body.append(panel);
  }
  const active=[...mediaPreparations.values()].find(value=>value.phase==='preparing')||mediaPreparations.values().next().value;
  const percent=Number.isFinite(active.progress)?Math.round(Math.max(0,Math.min(1,active.progress))*100):null;
  const message=`Preparing ${active.name} for playback${percent===null?'…':` · ${percent}%`}${mediaPreparations.size>1?` · ${mediaPreparations.size} files`:''}`;
  $('span',panel).textContent=message;
  const progress=$('progress',panel);
  if(percent===null)progress.removeAttribute('value');else progress.value=percent/100;
  $('#status-text').textContent=message;
}
// Undo snapshots serialize the whole composition. Continuous edits (slider
// drags, history='coalesce') become one step after a short pause; any other
// edit commits immediately so it stays its own undo step.

function changed(history=true){dirty=true;$('#save-state').textContent='UNSAVED';clearTimeout(saveTimer);saveTimer=setTimeout(autosave,800);if(history==='coalesce'){clearTimeout(historyTimer);historyTimer=setTimeout(commitHistory,250);}else if(history)commitHistory();}
function commitHistory(){clearTimeout(historyTimer);historyTimer=null;const value=snapshot();if(value!==lastHistory){undoStack.push(lastHistory);if(undoStack.length>60)undoStack.shift();redoStack=[];lastHistory=value;}}
async function autosave(){try{const data=serializeProject(project);if(desktop)await desktop.autosave(data);else localStorage.setItem('prism-recovery',JSON.stringify(data));$('#save-state').textContent=dirty?'RECOVERY SAVED':'SAVED';}catch(e){toast(`Recovery could not be saved: ${e.message}`,true);}}
function renderAll(){renderLayers();renderDecks();renderInspector();renderBrowser();syncGlobals();}
function applyPreferences(){
  document.documentElement.dataset.showAudio=String(preferences.showAudioControls);
  document.documentElement.dataset.layerTransport=String(preferences.showLayerTransport);
  document.documentElement.dataset.transitions=String(preferences.showTransitions);
}
function preferencesDialog(){
  const labels={clipPanelFollowsTrigger:'Clip panel follows triggered clips',showAudioControls:'Show audio controls',showLayerTransport:'Show transport in each layer',showTransitions:'Show transition controls in each layer',midiClockSync:'Sync BPM to incoming MIDI clock'};
  const deviceSelect=(key,label)=>`<label class="select-field"><span>${label}</span><select data-device-preference="${key}"><option value="">${key==='audioOutputDevice'?'System default':'None'}</option>${preferences[key]?`<option value="${esc(preferences[key])}" selected>Saved device</option>`:''}</select></label>`;
  const dialog=showDialog('Preferences',Object.entries(labels).map(([key,label])=>`<label class="preference-option"><input data-preference="${key}" type="checkbox" ${preferences[key]?'checked':''}>${label}</label>`).join('')
    +`<h3 style="margin-top:12px">Audio</h3>${deviceSelect('audioOutputDevice','Audio output')}${deviceSelect('audioInputDevice','External FFT input')}<p class="browser-note">The external input drives parameters set to Audio Analysis › external (a DJ feed, band or microphone).</p>`
    +`<h3 style="margin-top:12px">SMPTE timecode (LTC)</h3>${deviceSelect('smpteInputDevice','LTC input')}<label class="select-field"><span>Channel</span><select data-number-preference="smpteChannel">${Array.from({length:8},(_,index)=>`<option value="${index}" ${preferences.smpteChannel===index?'selected':''}>${index+1}</option>`).join('')}</select></label><label class="select-field"><span>Frame rate</span><select data-text-preference="smpteFps">${['auto','23.976','24','25','29.97','30'].map(value=>`<option value="${value}" ${preferences.smpteFps===value?'selected':''}>${value==='auto'?'Detect':value+' fps'}</option>`).join('')}</select></label><p class="browser-note">Clips set to SMPTE transport follow this timecode from their offset.</p>`
    +'<p class="browser-note">These settings apply to this computer and survive reopening PrismVJ.</p>',[['Cancel','cancel'],['Save settings','save']]);
  navigator.mediaDevices?.enumerateDevices?.().then(devices=>{
    for(const select of $$('[data-device-preference]',dialog)){
      const kind=select.dataset.devicePreference==='audioOutputDevice'?'audiooutput':'audioinput',saved=preferences[select.dataset.devicePreference];
      select.innerHTML=`<option value="">${kind==='audioinput'?'None':'System default'}</option>`+devices.filter(device=>device.kind===kind&&device.deviceId!=='default').map((device,index)=>`<option value="${esc(device.deviceId)}" ${device.deviceId===saved?'selected':''}>${esc(device.label||`${kind==='audioinput'?'Input':'Output'} ${index+1}`)}</option>`).join('');
    }
  }).catch(()=>{});
  dialog.addEventListener('close',async()=>{
    if(dialog.returnValue!=='save')return;
    try{
      const previous=preferences;
      preferences=writePreferences({...preferences,...Object.fromEntries($$('[data-preference]',dialog).map(input=>[input.dataset.preference,input.checked])),...Object.fromEntries($$('[data-device-preference]',dialog).map(select=>[select.dataset.devicePreference,select.value])),...Object.fromEntries($$('[data-number-preference]',dialog).map(select=>[select.dataset.numberPreference,Number(select.value)])),...Object.fromEntries($$('[data-text-preference]',dialog).map(select=>[select.dataset.textPreference,select.value]))});
      applyPreferences();renderAll();
      shortcuts.clock.enabled=preferences.midiClockSync;if(preferences.midiClockSync)shortcuts.enableMidi().catch(error=>toast(`MIDI unavailable: ${error.message}`,true));
      if(previous.audioInputDevice!==preferences.audioInputDevice)await engine.setExternalAudioInput(preferences.audioInputDevice||null);
      if(previous.smpteInputDevice!==preferences.smpteInputDevice||previous.smpteChannel!==preferences.smpteChannel||previous.smpteFps!==preferences.smpteFps)await startTimecode();
      if(previous.audioOutputDevice!==preferences.audioOutputDevice&&engine.audioContext?.setSinkId)await engine.audioContext.setSinkId(preferences.audioOutputDevice||'');
    }catch(error){toast('Settings could not be fully applied: '+error.message,true);}
  });
}
function layerPerformanceControls(layer){
  const clip=findClip(layer.activeClipId)?.clip;
  return `<details class="blend-options"><summary title="Blend favorites">⋯</summary><div class="blend-favorites">${(layer.blendFavorites||['normal','add','screen']).map((mode,index)=>`<select data-blend-favorite="${index}" aria-label="${esc(layer.name)} blend favorite ${index+1}" title="Choose and apply favorite ${index+1}">${blendOptions(mode)}</select>`).join('')}</div></details><div class="layer-transition"><label title="Transition duration">T<input data-transition-time type="range" min="0" max="10" step=".1" value="${layer.transition}" aria-label="${esc(layer.name)} transition time"></label><select data-transition-mode aria-label="${esc(layer.name)} transition mode">${blendOptions(layer.transitionMode,true)}</select></div><div class="layer-transport"><div class="row"><button data-layer-direction="-1" title="Reverse layer clip">◀</button><button data-layer-pause title="Pause layer clip">Ⅱ</button><button data-layer-direction="1" title="Forward layer clip">▶</button><span title="${esc(clip?.name||'No active clip')}">${esc(clip?.name||'Stopped')}</span></div><input data-layer-timeline type="range" min="0" max="1" step=".001" value="${transport.getState(layer.id)?.position||0}" ${clip?'':'disabled'} aria-label="${esc(layer.name)} playhead"></div>`;
}
function layerHeader(layer){
  const active=findClip(layer.activeClipId)?.clip;
  return `<div class="layer-head ${layer.id===selectedLayerId?'selected':''}"><div class="layer-actions"><button data-action="stop" title="Clear layer">×</button><button data-action="bypass" class="${layer.bypass?'active':''}" title="Bypass layer">B</button><button data-action="solo" class="${layer.solo?'active':''}" title="Solo layer">S</button><select data-layer-prop="blend" aria-label="${esc(layer.name)} blend">${blendOptions(layer.blend)}</select></div><div class="layer-faders">${[['av','M'],['volume','A'],['opacity','V']].map(([key,label])=>`<label class="fader-${key}" title="${label==='M'?'Linked audio and video':label==='A'?'Audio':'Video'}"><span>${label}</span><input data-layer-prop="${key}" aria-label="${esc(layer.name)} ${key==='volume'?'audio':key==='opacity'?'video':'linked audio video'}" type="range" min="0" max="1" step=".01" value="${layer[key]}"></label>`).join('')}</div><div class="layer-current">${active?`<div class="clip-art ${esc(active.kind==='source'?active.source:active.kind)}" style="${active.source==='solid'?`background:${esc(active.color)}`:''}">${clipThumbnail(active)}</div><span>${esc(active.name)}</span>`:'<span class="stopped-label">No clip</span>'}</div><div class="layer-performance">${layerPerformanceControls(layer)}</div><span class="name" data-layer-select="${layer.id}">${esc(layer.name)}</span><div class="layer-groups"><button data-group="A" class="${layer.group==='A'?'active':''}">A</button><button data-group="B" class="${layer.group==='B'?'active':''}">B</button></div></div>`;
}
function bindLayerPerformance(row,layer){
  for(const input of $$('[data-blend-favorite]',row))input.onchange=()=>{layer.blendFavorites[Number(input.dataset.blendFavorite)]=input.value;layer.blend=input.value;changed();renderLayers();if(inspectorTab==='layer')renderInspector();};
  $('[data-transition-time]',row).oninput=event=>{layer.transition=Number(event.target.value);changed();};
  $('[data-transition-mode]',row).onchange=event=>{layer.transitionMode=event.target.value;changed();};
  for(const button of $$('[data-layer-direction]',row))button.onclick=()=>{const clip=findClip(layer.activeClipId)?.clip;if(clip){clip.direction=Number(button.dataset.layerDirection);clip.paused=false;clip.random=false;changed();renderInspector();}};
  $('[data-layer-pause]',row).onclick=()=>{const clip=findClip(layer.activeClipId)?.clip;if(clip){clip.paused=!clip.paused;changed();renderInspector();}};
  $('[data-layer-timeline]',row).oninput=event=>transport.seek(layer.id,Number(event.target.value));
}
function syncGlobals(){for(const [selector,key] of [['#project-name','name'],['#bpm','bpm'],['#quantize','quantize'],['#global-speed','speed'],['#crossfader','crossfader'],['#master-opacity','masterOpacity'],['#master-volume','masterVolume']])$(selector).value=project[key];$('#pause').classList.toggle('active',project.paused);$('#blackout').classList.toggle('active',project.blackout);$('#bypass-all').classList.toggle('active',project.bypass);for(const button of $$('[data-global-direction]')){button.classList.toggle('pinned',project.directionPin===button.dataset.globalDirection);button.setAttribute('aria-pressed',String(project.directionPin===button.dataset.globalDirection));}$('#pause').classList.toggle('pinned',project.directionPin==='pause');$('#resolution').textContent=`${project.width} × ${project.height}`;}
function currentGroup(){return (project.groups||[]).find(group=>group.id===selectedGroupId)||(project.groups||[]).find(group=>group.id===currentLayer()?.groupId)||null;}
function inspectorTarget(scope){return scope==='composition'?project:scope==='layer'?currentLayer():scope==='group'?currentGroup():currentClip();}
function ownerPath(scope,target){return scope==='composition'?'composition':`${scope}/${target.id}`;}
// Bring visible controls in line with values changed by animation, shortcuts
// or OSC without rebuilding the panels. Focused controls are left alone.
function refreshControls(animatedOnly=false){
  const focused=document.activeElement;
  for(const host of $$('[data-inspector-panel]')){
    if(animatedOnly){refreshAnimatedControls(host,project);continue;}
    const target=inspectorTarget(host.dataset.scope);if(!target)continue;
    for(const input of $$('[data-param-path]',host)){
      if(input===focused)continue;const resolved=resolvePath(project,input.dataset.paramPath);if(!resolved)continue;
      const value=readOwner(resolved.scope,resolved.owner,resolved.key);
      if(input.type==='checkbox')input.checked=!!value;else if(input.dataset.axis!==undefined&&Array.isArray(value))input.value=value[Number(input.dataset.axis)];else if(input.dataset.number!==undefined)input.value=Number(value).toFixed(2);else if(input.type!=='color'||typeof value==='string')input.value=input.type==='color'?String(value).slice(0,7):value;
    }
    for(const input of $$('[data-prop],[data-number]',host)){
      if(input===focused)continue;const key=input.dataset.prop||input.dataset.number,value=target[key];
      if(typeof value!=='number')continue;
      const shown=input.dataset.unit==='pixels'?value*(key==='x'?project.width:project.height):value;
      input.value=input.dataset.number!==undefined?Number(shown).toFixed(2):shown;
    }
  }
  for(const row of $$('.layer-row')){const layer=project.layers.find(item=>item.id===row.dataset.layer);if(!layer)continue;for(const input of $$('[data-layer-prop]',row))if(input!==focused&&input.type==='range')input.value=layer[input.dataset.layerProp];}
  for(const row of $$('[data-group-row]')){const group=(project.groups||[]).find(item=>item.id===row.dataset.groupRow);if(!group)continue;for(const input of $$('[data-group-prop]',row))if(input!==focused&&input.type==='range')input.value=group[input.dataset.groupProp];}
  for(const [selector,key] of [['#bpm','bpm'],['#global-speed','speed'],['#crossfader','crossfader'],['#master-opacity','masterOpacity'],['#master-volume','masterVolume']])if($(selector)!==focused)$(selector).value=project[key];
  $('#pause').classList.toggle('active',project.paused);$('#blackout').classList.toggle('active',project.blackout);$('#bypass-all').classList.toggle('active',project.bypass);
  markFaders();
}
// Clip transport (manual pp. 58–63): Timeline or BPM Sync, in/out bar,
// direction and play mode buttons, Duration or Beats, and Playmode Away.
function speedLabel(value){return value===0?'0':value<1?`1/${Math.round(1/value)}`:`${value}×`;}
function generated(clip){return clip.kind==='source'||clip.kind==='effect';}
function playDuration(clip){return generated(clip)?clip.duration:(clip.outPoint-clip.inPoint)*clip.duration/(clip.stretch||1);}
function clipTransportHTML(clip){
  const bpm=clip.beatSync,mode=clip.random?'random':clip.loop;
  const radios=(attribute,items,active)=>`<div class="radio-group" role="radiogroup">${items.map(([value,icon,label])=>`<button ${attribute}="${value}" class="${active(value)?'active':''}" title="${label}" aria-label="${label}" aria-pressed="${active(value)}">${icon}</button>`).join('')}</div>`;
  return `<div class="section transport-section"><div class="row transport-head"><h3 class="grow">Transport <span class="muted">· ${esc(clip.kind)}</span></h3><select id="transport-mode" aria-label="Transport mode"><option value="timeline" ${!bpm&&!clip.smpte?'selected':''}>Timeline</option><option value="bpm" ${bpm&&!clip.smpte?'selected':''}>BPM Sync</option><option value="smpte" ${clip.smpte?'selected':''}>SMPTE</option></select></div>
    <input id="timeline" class="timeline" type="range" min="0" max="1" step=".001" value="0" aria-label="Clip playhead">${inOutBarHTML('id="clip-inout"',clip.inPoint,clip.outPoint)}
    <div class="time-labels"><span id="clip-time" title="Click to switch between time and time remaining" role="button" tabindex="0">00:00.00</span><span>${bpm?`${clip.beats} beats`:`${playDuration(clip).toFixed(2)} s`}</span></div>
    <div class="transport-row">${radios('data-direction',[[-1,'◀','Play backward'],[0,'Ⅱ','Pause'],[1,'▶','Play forward']],value=>value===0?clip.paused:clip.direction===value&&!clip.paused)}${radios('data-playmode',PLAYMODES,value=>value===mode)}<span class="grow"></span><button id="retrigger" title="Restart clip (piano clips play while held)" aria-label="Restart clip">↻</button></div>
    ${bpm?`<div class="transport-row"><label class="anim-label">Speed</label><div class="radio-group speed-steps">${BPM_SPEEDS.map(value=>`<button data-bpm-speed="${value}" class="${(clip.bpmSpeed??1)===value?'active':''}">${speedLabel(value)}</button>`).join('')}</div></div><div class="transport-row"><label class="anim-label">Beats</label><div class="beat-field"><button data-clip-beats="half" title="Divide by 2">÷2</button><button data-clip-beats="minus" title="One beat less">−</button><input id="clip-beats" type="number" min=".03125" max="4096" step="any" value="${clip.beats}" aria-label="Clip beats"><button data-clip-beats="plus" title="One beat more">+</button><button data-clip-beats="double" title="Multiply by 2">×2</button></div></div>`
      :`${range('Speed','speed',clip.speed,0,4)}<div class="transport-row"><label class="anim-label">Duration</label><div class="beat-field"><input id="clip-duration" type="number" min=".01" max="86400" step="any" value="${playDuration(clip).toFixed(2)}" aria-label="Duration in seconds"><span class="unit">s</span></div></div>`}
    ${clip.smpte?`<div class="transport-row"><label class="anim-label" title="Timecode at which this clip's first frame plays">Offset</label><input id="smpte-offset" class="timecode-field" value="${esc(formatTimecode(clip.smpteOffset,timecodeFps(),false))}" aria-label="SMPTE offset" spellcheck="false"><label class="anim-label" title="After the clip's end">End</label><select id="smpte-end" aria-label="After the end">${[['hold','Hold'],['loop','Loop'],['stop','Stop']].map(([value,label])=>`<option value="${value}" ${clip.smpteEnd===value?'selected':''}>${label}</option>`).join('')}</select></div><small class="muted">${timecode?'Follows the SMPTE input once triggered.':'Choose an SMPTE input in Settings.'}</small>`:''}
    ${mode==='random'?`<div class="transport-row"><label class="anim-label" title="How often the playhead jumps">Interval</label><div class="beat-field"><input id="random-interval" type="number" min=".01" max="86400" step="any" value="${clip.randomInterval??''}" placeholder="auto" aria-label="Random interval"><span class="unit">${bpm?'beats':'s'}</span></div><label class="anim-label" title="How far each jump may go">Distance</label><div class="beat-field"><input id="random-distance" type="number" min="0" max="86400" step="any" value="${clip.randomDistance??''}" placeholder="all" aria-label="Random distance"><span class="unit">${bpm?'beats':'s'}</span></div></div>`:''}
    <div class="transport-row"><label class="anim-label" title="What happens when you trigger this clip again after playing something else">Away</label>${radios('data-away',[['restart','Restart','Play from the start'],['continue','Pick-up','Continue where it was'],['relative','Relative','Start at the relative position of the clip that was playing']],value=>clip.trigger===value)}</div>`;
}
function bindClipTransport(clip,$){
  const bpmBeats=()=>2**Math.max(-2,Math.min(10,Math.round(Math.log2(Math.max(0.01,playDuration(clip))*project.bpm/60))));
  $('#transport-mode').onchange=event=>{
    clip.smpte=event.target.value==='smpte';
    clip.beatSync=event.target.value==='bpm';
    // Resolume guesses beats to the nearest power of two and keeps speed on the grid.
    if(clip.beatSync)clip.beats=bpmBeats();
    changed();renderInspector();
  };
  for(const button of $$('[data-direction="0"]'))button.onclick=()=>{clip.paused=!clip.paused;changed();renderInspector();};
  for(const button of $$('[data-playmode]'))button.onclick=()=>{clip.loop=button.dataset.playmode;clip.random=false;changed();renderInspector();};
  for(const button of $$('[data-bpm-speed]'))button.onclick=()=>{clip.bpmSpeed=Number(button.dataset.bpmSpeed);changed();renderInspector();};
  for(const button of $$('[data-clip-beats]'))button.onclick=()=>{const op=button.dataset.clipBeats;clip.beats=Math.max(.03125,Math.min(4096,op==='half'?clip.beats/2:op==='double'?clip.beats*2:op==='plus'?Math.floor(clip.beats)+1:Math.max(1,Math.ceil(clip.beats)-1)));changed();renderInspector();};
  $('#clip-beats')?.addEventListener('change',event=>{clip.beats=Math.max(.03125,Math.min(4096,Number(event.target.value)||16));changed();renderInspector();});
  // Duration sets how long in→out lasts at speed 1, independent of the Speed slider.
  $('#clip-duration')?.addEventListener('change',event=>{const seconds=Math.max(.01,Math.min(86400,Number(event.target.value)||1));if(generated(clip))clip.duration=seconds;else clip.stretch=(clip.outPoint-clip.inPoint)*clip.duration/seconds;changed();renderInspector();});
  $('#smpte-offset')?.addEventListener('change',event=>{const parsed=parseTimecode(event.target.value,timecodeFps(),event.target.value.includes(';'));if(parsed){clip.smpteOffset=timecodeToSeconds(parsed);changed();}else toast('Use a timecode like 01:00:00:00.',true);renderInspector('clip');});
  $('#smpte-end')?.addEventListener('change',event=>{clip.smpteEnd=event.target.value;changed();});
  for(const [selector,key] of [['#random-interval','randomInterval'],['#random-distance','randomDistance']])$(selector)?.addEventListener('change',event=>{const value=event.target.value.trim();clip[key]=value===''?null:Math.max(key==='randomInterval'?.01:0,Math.min(86400,Number(value)||0));changed();});
  for(const button of $$('[data-away]'))button.onclick=()=>{clip.trigger=button.dataset.away;changed();renderInspector();};
  const time=$('#clip-time');if(time){time.onclick=()=>{showRemaining=!showRemaining;};time.onkeydown=event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();showRemaining=!showRemaining;}};}
  bindInOutBar($('#clip-inout'),()=>[clip.inPoint,clip.outPoint],(lo,hi,done)=>{clip.inPoint=lo;clip.outPoint=hi;changed(done?true:'coalesce');if(done)renderInspector();});
}
function promptText(title,value=''){return new Promise(resolve=>{const dialog=showDialog(title,`<input id="prompt-text" type="text" value="${esc(value)}" maxlength="120" style="width:100%">`,[['Cancel','cancel'],['OK','ok']]);const input=$('#prompt-text',dialog);input.select();input.onkeydown=event=>{if(event.key==='Enter'){event.preventDefault();dialog.close('ok');}};dialog.addEventListener('close',()=>resolve(dialog.returnValue==='ok'?input.value.trim()||null:null));});}
function addEffect(target,data,alt=false){
  if(!target)return toast('Select a clip, layer or group first.');
  const audio=data.kind==='audio',definition=(audio?audioEffectDefinition:effectDefinition)(data.type);
  if(!definition)return toast('That effect is not available.',true);
  if(audio&&target.kind==='effect')return toast('Effect clips carry video effects only.');
  const list=audio?(target.audioEffects||=[]):target.effects;
  if(list.length>=LIMITS.effects)return toast('Effect stack limit reached.');
  const effect={id:id(),type:data.type,enabled:true,params:defaultParams(definition),animations:{}};
  // Alt-drop adds the effect faded out so it can be brought in (manual p. 81).
  if(!audio){effect.opacity=alt?0:1;effect.blend='normal';}
  const preset=data.preset!==undefined?readPresets()[`${audio?'audio:':''}${data.type}`]?.[data.preset]:null;
  if(preset)applyPreset(effect,preset);
  list.push(effect);changed();
  // Only the panel showing this target changes.
  const panel=target===inspectorTarget('clip')?'clip':target===inspectorTarget(contextTab)?'context':null;
  renderInspector(panel);
  return effect;
}
function stepLayerClip(layer,step){
  const clips=clipList(layer),count=clips.length,current=clips.findIndex(clip=>clip?.id===layer.activeClipId),start=current<0?(step>0?-1:count):current;
  for(let offset=1;offset<=count;offset++){const clip=clips[(((start+offset*step)%count)+count)%count];if(clip){trigger(layer,clip);return clip;}}
  return null;
}
function addPropertyCogs(host,scope,target){
  const keys=new Set((PROPERTY_PARAMS[scope]||[]).filter(param=>param.type!=='bool').map(param=>param.key)),base=ownerPath(scope,target);
  for(const range of $$('.field input[type="range"][data-prop]',host)){
    const key=range.dataset.prop;if(!keys.has(key))continue;
    const field=range.closest('.field'),path=`${base}/${key}`;
    if(field.querySelector('.param-cog'))continue;
    field.insertAdjacentHTML('beforeend',cogButton(path,target,key));field.classList.add('has-cog');
    for(const input of $$('[data-prop],[data-number]',field))input.dataset.animateOwner=path;
    field.classList.toggle('animated',!!target.animations?.[key]);
  }
}
// Compile shaders in the background so first use never stalls a frame:
// what the composition uses first, then the whole catalog.
function prewarmCatalog(){
  const used=new Set();
  for(const owner of [project,...(project.groups||[]),...project.layers,...project.layers.flatMap(layer=>Object.values(layer.clips).flat()).filter(Boolean)])for(const effect of owner.effects||[])used.add(effect.type);
  engine.prewarm([...used].map(effectDefinition).filter(Boolean),{priority:true});
  engine.prewarm(listEffects().filter(definition=>!definition.legacy));
  engine.prewarm(listSources().filter(definition=>definition.glsl),{kind:'source'});
}
// Ask for thumbnails of clips that lack one (MOVs and stills have their own).
function requestThumbnails(){
  for(const layer of project.layers)for(const clip of Object.values(layer.clips).flat())
    if(clip&&!clip.thumbnail&&(clip.kind==='source'&&sourceDefinition(clip.source)?.glsl||(clip.kind==='video'&&!/\.mov$/i.test(clip.path||''))))thumbnailer?.request(clip);
}
// SMPTE (LTC) input: clips in SMPTE transport follow the incoming timecode
// from their offset. They still need to be triggered (manual p. 205).
async function startTimecode(){
  timecode?.stop();timecode=null;
  if(!preferences.smpteInputDevice)return updateTimecodeStatus();
  try{
    const stream=await navigator.mediaDevices.getUserMedia({audio:{deviceId:{exact:preferences.smpteInputDevice},echoCancellation:false,noiseSuppression:false,autoGainControl:false}});
    const input=new TimecodeInput(engine.audioContext,{fps:preferences.smpteFps==='auto'?'auto':Number(preferences.smpteFps)});
    await input.start(stream,{channel:preferences.smpteChannel});
    timecode=input;
  }catch(error){toast(`SMPTE input unavailable: ${error.message}`,true);}
  updateTimecodeStatus();
}
// Ableton Link (manual: BPM sync with other apps). The main process streams
// the session; the beat clock follows its phase and tempo changes flow both ways.
async function setupLink(){
  if(!desktop?.linkStatus)return;
  const status=await desktop.linkStatus().catch(()=>null);
  if(!status?.available)return;
  $('#link').hidden=false;
  desktop.onLinkState(state=>{
    const previous=link;
    link={...state,receivedAt:now()};
    if(!state.enabled){updateLinkButton();return;}
    if(Math.abs(state.tempo-project.bpm)>0.005&&Math.abs(state.tempo-lastLinkTempo)>0.0001){
      lastLinkTempo=state.tempo;project.bpm=Math.round(state.tempo*1000)/1000;
      if(document.activeElement!==$('#bpm'))$('#bpm').value=Number(project.bpm.toFixed(2));
    }
    transport.syncBeat(state.beat,state.quantum,now());
    if(preferences.linkStartStop&&previous.playing!==state.playing&&lastLinkPlaying!==state.playing){lastLinkPlaying=state.playing;project.paused=!state.playing;syncGlobals();}
    if(previous.peers!==state.peers||previous.enabled!==state.enabled)updateLinkButton();
  });
  if(preferences.linkStartStop)await desktop.linkStartStopSync(true).catch(()=>{});
  if(preferences.linkEnabled)await toggleLink(true);
}
async function toggleLink(on=!link.enabled){
  try{
    const state=await desktop.linkEnable(on);
    link={...link,...state,receivedAt:now()};
    // Joining a session adopts its tempo; an empty session takes ours.
    if(on&&state.peers===0)await desktop.linkTempo(project.bpm);
    preferences=writePreferences({...preferences,linkEnabled:on});
    updateLinkButton();
    if(on)toast(state.peers?`Link: joined a session with ${state.peers} peer${state.peers===1?'':'s'} at ${state.tempo.toFixed(1)} BPM.`:'Link on: waiting for peers on the network.');
  }catch(error){toast(error.message,true);}
}
function updateLinkButton(){
  const button=$('#link');if(!button)return;
  button.classList.toggle('active',!!link.enabled);
  button.textContent=link.enabled?`Link ${link.peers}`:'Link';
  button.title=link.enabled?`Ableton Link · ${link.peers} peer${link.peers===1?'':'s'} · ${(link.tempo||project.bpm).toFixed(2)} BPM. Right-click for options.`:'Ableton Link: sync tempo and beat with other apps on the network. Right-click for options.';
}
// Our tempo edits go to the Link session (not echoes of its own changes).
function linkTempoChanged(){if(link.enabled&&Math.abs(project.bpm-lastLinkTempo)>0.0001){lastLinkTempo=project.bpm;desktop.linkTempo(project.bpm).catch(()=>{});}}
function timecodeFps(){return timecode?.state.fps||(preferences.smpteFps==='auto'?25:Number(preferences.smpteFps));}
function followTimecode(frames){
  const state=timecode.state;
  if(!state.locked)return;
  for(const frame of frames){
    if(!frame.clip.smpte||frame.transitionIncoming===false)continue;
    const position=clipTimeFromTimecode({timecodeSeconds:state.seconds,clipOffsetSeconds:frame.clip.smpteOffset,clipDuration:frame.clip.duration,inPoint:frame.clip.inPoint,outPoint:frame.clip.outPoint,mode:frame.clip.smpteEnd});
    if(position!==null&&Math.abs(position-frame.position)*frame.clip.duration>0.04)transport.seek(frame.layer.id,position);
  }
}
function updateTimecodeStatus(){
  const label=!timecode?'':timecode.state.locked?`TC ${timecode.state.timecode}`:'TC —';
  if(label===lastTimecodeLabel)return;
  lastTimecodeLabel=label;
  const status=$('#timecode-status');if(status){status.textContent=label;status.hidden=!label;}
}
function spectrumFor(source){return engine.spectrum(source,source==='clip'?selectedClipId:source==='layer'?selectedLayerId:source==='group'?currentGroup()?.id:null);}
// Like Resolume's M slider, video faders turn red below 100% so a faded
// layer or master is obvious at a glance.
const FADER_SELECTOR='[data-layer-prop="opacity"],[data-layer-prop="av"],[data-group-prop="opacity"],#master-opacity';
function markFaders(root=document){for(const input of root.querySelectorAll(FADER_SELECTOR))input.classList.toggle('below-full',Number(input.value)<0.999);}
function scheduleRefresh(){if(refreshQueued)return;refreshQueued=true;requestAnimationFrame(()=>{refreshQueued=false;refreshControls();});}

function renderLayers(){
  document.documentElement.style.setProperty('--columns',project.columns||8);
  renderColumns();
  lastActive=project.layers.map(l=>l.activeClipId).join(',');
  $('#layer-bank').innerHTML=[...project.layers].reverse().map((layer,index,list)=>`${groupHeaderFor(layer,list[index-1])}<div class="layer-row ${layer.groupId?'in-group':''} ${groupOfLayer(layer)?.collapsed?'group-collapsed':''} ${layer.locked?'locked':''}" data-layer="${layer.id}">${layerHeader(layer)}<div class="clips">${clipList(layer).map((clip,index)=>clip?`<button class="clip-slot ${selectedClips.has(clip.id)?'selected':''} ${project.layers.some(item=>item.activeClipId===clip.id)?'playing':''}" data-slot="${index}" data-clip="${clip.id}" draggable="true" title="${esc(clip.name)} — click to trigger, right-click to edit"><div class="clip-art ${esc(clip.kind==='source'?clip.source:clip.kind)}" style="${clip.source==='solid'?`background:${esc(clip.color)}`:''}">${clipThumbnail(clip)}<span class="clip-kind">${clip.kind==='source'?'GEN':esc(clip.kind.toUpperCase())}</span></div><span class="clip-name">${esc(clip.name)}</span><div class="clip-progress"></div></button>`:`<button class="clip-slot empty-slot ${layer.id===selectedLayerId&&index===selectedColumn&&!selectedClipId?'selected':''}" data-slot="${index}" title="Drop media or double-click to import">+</button>`).join('')}</div></div>`).join('');
  bindGroupRows();
  markFaders($('#layer-bank'));
  for(const row of $$('.layer-row')){
    const layer=project.layers.find(l=>l.id===row.dataset.layer);
    $('[data-layer-select]',row).onclick=()=>{selectedLayerId=layer.id;selectedGroupId=layer.groupId;inspectorTab='layer';renderLayers();renderInspector();};
    $('[data-layer-select]',row).oncontextmenu=event=>{event.preventDefault();layerMenu(layer,event);};
    const head=$('.layer-head',row);
    head.ondragover=event=>{if(event.dataTransfer.types.includes('application/prism-effect')){event.preventDefault();head.classList.add('drag-over');}};
    head.ondragleave=()=>head.classList.remove('drag-over');
    head.ondrop=event=>{head.classList.remove('drag-over');const data=event.dataTransfer.getData('application/prism-effect');if(!data)return;event.preventDefault();selectedLayerId=layer.id;inspectorTab='layer';addEffect(layer,JSON.parse(data),event.altKey);renderLayers();};
    for(const input of $$('[data-layer-prop]',row)) input.oninput=()=>{layer[input.dataset.layerProp]=input.type==='range'?+input.value:input.value;markFaders(row);changed(input.type==='range'?'coalesce':true);};
    for(const button of $$('[data-action]',row))button.onclick=()=>{const action=button.dataset.action;if(action==='stop'){triggerRequests.delete(layer.id);transport.stop(layer.id);}else layer[action]=!layer[action];changed();renderLayers();};
    bindLayerPerformance(row,layer);
    for(const button of $$('[data-group]',row))button.onclick=()=>{layer.group=layer.group===button.dataset.group?'none':button.dataset.group;changed();renderLayers();};
    for(const slot of $$('[data-slot]',row)){
      const index=+slot.dataset.slot,clip=clipList(layer)[index];
      const shown=visibleSlot(project,layer,project.selectedDeckId,index);
      slot.classList.toggle('has-label-color',Boolean(clip?.labelColor));
      if(clip?.labelColor)slot.style.setProperty('--clip-highlight',clip.labelColor);
      if(clip?.persistent){
        const badge=document.createElement('span');badge.className='persistent-badge';badge.textContent='P';badge.title='Persistent across decks';
        $('.clip-art',slot)?.append(badge);
        slot.classList.toggle('persistent-proxy',shown.persistentFrom!==project.selectedDeckId);
      }
      if(shown.covered){
        const mini=document.createElement('span');mini.className='covered-clip';mini.draggable=true;
        mini.title=`${shown.covered.name} is covered. Drag it to an empty clip slot to reveal it.`;
        mini.innerHTML=clipThumbnail(shown.covered)||`<span>${esc(shown.covered.name.slice(0,1))}</span>`;
        mini.onclick=event=>{event.stopPropagation();selectClip(layer,shown.covered,index);startPreview(shown.covered);};
        mini.onpointerdown=event=>event.stopPropagation();
        mini.ondragstart=event=>{event.stopPropagation();event.dataTransfer.setData('application/prism-clip',JSON.stringify({layerId:layer.id,clipId:shown.covered.id}));};
        $('.clip-art',slot)?.append(mini);
      }
      slot.onclick=e=>{const destination=selectedLayerId;if(!clip||e.shiftKey)selectClip(layer,clip,index,e.shiftKey);if(clip&&!e.shiftKey&&!transport.isPiano(clip))trigger(layer,clip,()=>true,{selectedLayerId:destination});};
      $('.clip-name',slot)?.addEventListener('click',event=>{event.stopPropagation();selectClip(layer,clip,index,event.shiftKey);if(!event.shiftKey)startPreview(clip);});
      slot.oncontextmenu=e=>{
        e.preventDefault();
        if(clip)return selectClip(layer,clip,index);
        selectClip(layer,null,index);
        showMenu(e,[['Import media…',()=>importFiles(layer,index)],['Import image sequence…',()=>importSequence(layer,index),!desktop?.importSequence],['-'],...['solid','gradient','text-animator'].filter(sourceDefinition).map(source=>[`Add ${sourceDefinition(source).name}`,()=>addSource(source,layer,index)])]);
      };
      slot.ondblclick=()=>{if(!clip)importFiles(layer,index);};
      slot.onpointerdown=e=>{if(e.button===0&&!e.shiftKey&&!e.target.closest('.clip-name')&&clip&&transport.isPiano(clip)){const inputId=id(),held={layerId:layer.id,clipId:clip.id,inputId};heldPointers.set(e.pointerId,held);trigger(layer,clip,()=>heldPointers.get(e.pointerId)===held,{selectedLayerId,inputId});}};
      slot.ondragstart=e=>{if(clip)e.dataTransfer.setData('application/prism-clip',JSON.stringify({layerId:layer.id,clipId:clip.id}));};
      slot.ondragover=e=>{e.preventDefault();slot.classList.add('drag-over');};
      slot.ondragleave=()=>slot.classList.remove('drag-over');
      slot.ondrop=async e=>{
        e.preventDefault();slot.classList.remove('drag-over');
        try{
          const source=e.dataTransfer.getData('application/prism-source'),move=e.dataTransfer.getData('application/prism-clip'),path=e.dataTransfer.getData('application/prism-path');
          const effectData=e.dataTransfer.getData('application/prism-effect');
          if(effectData){
            // An effect dropped on a clip applies to it; on an empty slot it
            // creates an Effect Clip (manual p. 85).
            const data=JSON.parse(effectData);
            if(clip){addEffect(clip,data,e.altKey);selectClip(layer,clip,index);}
            else if(data.kind!=='audio'){addSource('effect-clip',layer,index);const created=clipList(layer)[index];if(created)addEffect(created,data,e.altKey);}
            return;
          }
          if(source)addSource(source,layer,index,JSON.parse(e.dataTransfer.getData('application/prism-source-extra')||'{}'));
          else if(move){const data=JSON.parse(move),from=slotForClip(data.clipId),to={layerId:layer.id,deckId:project.selectedDeckId,column:index};if(!from)return;
            const incoming=findClip(data.clipId)?.clip;
            if(e.shiftKey&&clip&&incoming?.kind==='audio')await pairAudio(clip,{name:incoming.name,kind:'audio',path:incoming.path,url:incoming.url});
            else{if(e.ctrlKey)composition.pasteClip(project,to,composition.copyClip(project,from));else composition.moveClip(project,from,to);transport.tick(now());changed();renderAll();}}
          else if(path){const [item]=await desktop.importPaths([path]);if(e.shiftKey&&clip&&item.kind==='audio')await pairAudio(clip,item);else await placeMedia(item,layer,index);}
          else if(e.shiftKey&&clip&&e.dataTransfer.files.length===1){const item=await itemFromFile(e.dataTransfer.files[0]);if(item.kind==='audio')await pairAudio(clip,item);else await placeMedia(item,layer,index);}
          else await importFileList([...e.dataTransfer.files],layer,index);
        }catch(error){toast(error.message,true);}
      };
    }
  }
  layerPlayheads.clear();clipPlayheads.clear();queuedSlots.clear();
  for(const row of $$('.layer-row')){
    layerPlayheads.set(row.dataset.layer,$('[data-layer-timeline]',row));
    const slots=$$('[data-clip]',row);
    queuedSlots.set(row.dataset.layer,slots);
    for(const slot of slots)clipPlayheads.set(slot.dataset.clip,$('.clip-progress',slot));
  }
}
function groupOfLayer(layer){return layer.groupId?(project.groups||[]).find(group=>group.id===layer.groupId)||null:null;}
function groupHeaderFor(layer,above){
  const group=groupOfLayer(layer);
  if(!group||above?.groupId===group.id)return '';
  const count=project.layers.filter(item=>item.groupId===group.id).length;
  return `<div class="group-row ${group.id===currentGroup()?.id&&inspectorTab==='group'?'selected':''}" data-group-row="${group.id}"><button data-group-collapse title="${group.collapsed?'Expand':'Collapse'} group">${group.collapsed?'▸':'▾'}</button>
    <span class="name" data-group-select title="Group of ${count} layer${count===1?'':'s'}; right-click for options">${esc(group.name)}</span>
    <button data-group-action="clear" title="Eject group">×</button><button data-group-action="bypass" class="${group.bypass?'active':''}" title="Bypass group">B</button><button data-group-action="solo" class="${group.solo?'active':''}" title="Solo group">S</button>
    <select data-group-prop="blend" aria-label="${esc(group.name)} blend">${blendOptions(group.blend)}</select>
    ${[['opacity','V',1],['volume','A',1],['speed','Speed',4]].map(([key,label,max])=>`<label title="${key}"><span>${label}</span><input type="range" data-group-prop="${key}" min="0" max="${max}" step=".01" value="${group[key]}" aria-label="${esc(group.name)} ${key}"></label>`).join('')}
    <div class="group-columns" title="Group column triggers">${Array.from({length:project.columns||8},(_,column)=>`<button data-group-column="${column}">${column+1}</button>`).join('')}</div></div>`;
}
function bindGroupRows(){
  for(const row of $$('[data-group-row]')){
    const group=(project.groups||[]).find(item=>item.id===row.dataset.groupRow);if(!group)continue;
    $('[data-group-select]',row).onclick=()=>{selectedGroupId=group.id;inspectorTab='group';renderLayers();renderInspector();};
    $('[data-group-select]',row).oncontextmenu=event=>{event.preventDefault();showMenu(event,[['Rename',()=>editName(group,'Group name',()=>{changed();renderAll();})],['Ungroup',()=>editComposition(()=>composition.ungroup(project,group.id))]]);};
    $('[data-group-collapse]',row).onclick=()=>{group.collapsed=!group.collapsed;changed();renderLayers();};
    for(const button of $$('[data-group-action]',row))button.onclick=()=>{const action=button.dataset.groupAction;if(action==='clear'){for(const layer of project.layers)if(layer.groupId===group.id){triggerRequests.delete(layer.id);transport.stop(layer.id);}}else group[action]=!group[action];changed();renderLayers();};
    for(const input of $$('[data-group-prop]',row))input.oninput=()=>{group[input.dataset.groupProp]=input.type==='range'?Number(input.value):input.value;markFaders(row);changed(input.type==='range'?'coalesce':true);if(inspectorTab==='group')scheduleRefresh();};
    for(const button of $$('[data-group-column]',row))button.onclick=()=>triggerColumn(Number(button.dataset.groupColumn),{groupId:group.id});
  }
}
// Context menu. Items are [label, action, disabled] or [label, [subitems]].
function showMenu(event,items){
  for(const old of $$('.context-menu'))old.remove();
  const close=()=>{for(const menu of $$('.context-menu'))menu.remove();document.removeEventListener('pointerdown',outside,true);};
  const outside=e=>{if(!e.target.closest('.context-menu'))close();};
  const open=(entries,x,y,level)=>{
    for(const menu of $$('.context-menu'))if(Number(menu.dataset.level)>=level)menu.remove();
    const menu=document.createElement('div');menu.className='context-menu';menu.dataset.level=level;menu.setAttribute('role','menu');
    menu.innerHTML=entries.map(([label,action,disabled],index)=>label==='-'?'<hr>':`<button role="menuitem" data-menu="${index}" ${disabled?'disabled':''} ${Array.isArray(action)?'aria-haspopup="menu"':''}>${esc(label)}${Array.isArray(action)?'<span class="submenu-arrow">›</span>':''}</button>`).join('');
    document.body.append(menu);
    menu.style.left=`${Math.max(4,Math.min(x,innerWidth-menu.offsetWidth-8))}px`;menu.style.top=`${Math.max(4,Math.min(y,innerHeight-menu.offsetHeight-8))}px`;
    for(const button of $$('[data-menu]',menu)){
      const action=entries[Number(button.dataset.menu)][1];
      const openChild=()=>{const rect=button.getBoundingClientRect();open(action,rect.right-2,rect.top-3,level+1);};
      if(Array.isArray(action)){button.onclick=openChild;button.onpointerenter=openChild;button.onkeydown=e=>{if(e.key==='ArrowRight'){e.preventDefault();openChild();$('.context-menu[data-level="'+(level+1)+'"] button')?.focus();}};}
      else{button.onclick=()=>{close();action();};button.onpointerenter=()=>{for(const menu of $$('.context-menu'))if(Number(menu.dataset.level)>level)menu.remove();};}
    }
    menu.onkeydown=e=>{if(e.key==='Escape'){e.stopPropagation();close();}else if(e.key==='ArrowLeft'&&level>0){menu.remove();}};
    menu.querySelector('button:not([disabled])')?.focus();
  };
  open(items,event.clientX,event.clientY,0);
  setTimeout(()=>document.addEventListener('pointerdown',outside,true),0);
}
// Layer menu (manual pp. 40–42): groups, duplicate, rename, clear and remove.
function layerMenu(layer,event){
  const groups=(project.groups||[]).filter(group=>group.id!==layer.groupId);
  showMenu(event,[
    ['Group › New',()=>editComposition(()=>{selectedGroupId=composition.createGroupForLayer(project,layer.id).id;})],
    ...groups.map(group=>[`Group › ${group.name}`,()=>editComposition(()=>composition.setLayerGroup(project,layer.id,group.id))]),
    ['Group › None',()=>editComposition(()=>composition.setLayerGroup(project,layer.id,null)),!layer.groupId],
    ['-'],
    ['Rename…',()=>editName(layer,'Layer name',()=>{changed();renderAll();})],
    ['Duplicate',()=>editComposition(()=>{selectedLayerId=composition.duplicateLayer(project,layer.id).id;})],
    [layer.locked?'Unlock content':'Lock content',()=>{layer.locked=!layer.locked;changed();renderLayers();renderInspector();}],
    ['Clear clips',()=>editComposition(()=>{transport.stop(layer.id);composition.clearLayerClips(project,layer.id);})],
    ['Remove layer',()=>{if(project.layers.length===1)return toast('Keep at least one layer.');editComposition(()=>{transport.stop(layer.id);composition.removeLayer(project,layer.id);composition.pruneGroups(project);});}],
  ]);
}
function options(values,selected){return values.map(v=>`<option value="${esc(v)}" ${String(v)===String(selected)?'selected':''}>${esc(v)}</option>`).join('');}
function slotForClip(clipId){return composition.findClipSlot(project,clipId);}
function allClips(){return project.layers.flatMap(layer=>Object.values(layer.clips).flat()).filter(Boolean);}
function editComposition(action){
  const before=allClips();
  try{
    action();transport.tick(now());
    const remaining=new Set(allClips().map(clip=>clip.id));
    for(const clip of before)if(!remaining.has(clip.id)){engine.remove(clip.id);if(clip.mask)engine.removeMask?.(clip.mask.id);selectedClips.delete(clip.id);}
    if(selectedClipId&&!remaining.has(selectedClipId))selectedClipId=null;
    if(!project.layers.some(layer=>layer.id===selectedLayerId))selectedLayerId=project.layers.at(-1).id;
    selectedColumn=Math.min(selectedColumn,(project.columns||8)-1);
    changed();renderAll();
  }catch(error){toast(error.message,true);}
}
function renderColumns(){
  const header=$('#column-heads');if(!header)return;
  header.innerHTML=Array.from({length:project.columns||8},(_,column)=>`<button data-column="${column}" title="Trigger column ${column+1}; right-click to edit">Column ${column+1}</button>`).join('');
  for(const button of $$('[data-column]',header)){
    button.onpointerdown=event=>{if(event.button===0)beginColumnHold(Number(button.dataset.column),heldPointers,event.pointerId);};
    button.onclick=event=>{if(event.detail===0)triggerColumn(Number(button.dataset.column));};
    button.oncontextmenu=event=>{event.preventDefault();selectedColumn=Number(button.dataset.column);columnActions();};
  }
}
function deckActions(){
  const deck=project.decks.find(item=>item.id===project.selectedDeckId),index=project.decks.indexOf(deck);
  const dialog=showDialog('Edit deck',`<label class="select-field">Name<input id="deck-name" type="text" value="${esc(deck.name)}" maxlength="120"></label><p>Deck ${index+1} of ${project.decks.length}. Removing a deck removes its clips; Undo restores them.</p>`,[['Cancel','cancel'],['Move left','left'],['Move right','right'],['Insert before','insert'],['Remove deck','remove'],['Apply name','rename']]);
  dialog.addEventListener('close',()=>{
    const action=dialog.returnValue;if(!action||action==='cancel')return;
    editComposition(()=>{
      if(action==='rename')composition.renameDeck(project,deck.id,$('#deck-name',dialog).value);
      else if(action==='insert')project.selectedDeckId=composition.addDeck(project,undefined,index).id;
      else if(action==='remove')composition.removeDeck(project,deck.id);
      else composition.moveDeck(project,deck.id,Math.min(project.decks.length-1,Math.max(0,index+(action==='left'?-1:1))));
    });
  });
}
function columnActions(){
  const dialog=showDialog('Edit columns',`<label class="select-field">Column count<input id="column-count" type="number" min="1" max="${LIMITS.columns}" value="${project.columns||8}"></label><label class="select-field">Selected column<input id="column-index" type="number" min="1" max="${project.columns||8}" value="${selectedColumn+1}"></label><p>Insert moves later clips right. Removing the selected column removes its clips from every deck. Reducing the count is allowed only when the removed columns are empty.</p>`,[['Cancel','cancel'],['Insert before','insert'],['Remove column','remove'],['Apply count','count']]);
  dialog.addEventListener('close',()=>{const action=dialog.returnValue;if(!action||action==='cancel')return;const index=Number($('#column-index',dialog).value)-1;editComposition(()=>{if(action==='count')composition.setColumnCount(project,Number($('#column-count',dialog).value));else if(action==='insert')composition.insertColumn(project,index);else composition.removeColumn(project,index);selectedColumn=Math.min(index,project.columns-1);});});
}
function copySelection(cut){
  const ids=selectedClips.size?[...selectedClips]:selectedClipId?[selectedClipId]:[];
  const slots=ids.map(slotForClip).filter(Boolean);
  if(!slots.length)return toast('Select a clip to copy or cut.');
  const left=Math.min(...slots.map(slot=>slot.column)),bottom=Math.min(...slots.map(slot=>project.layers.findIndex(layer=>layer.id===slot.layerId)));
  clipClipboard={items:slots.map(slot=>({layerOffset:project.layers.findIndex(layer=>layer.id===slot.layerId)-bottom,columnOffset:slot.column-left,data:cut?composition.cutClip(project,slot):composition.copyClip(project,slot)}))};
  toast(`${slots.length} clip${slots.length===1?'':'s'} ${cut?'ready to move':'copied'}. Select a destination and paste.`);
}
function pasteSelection(){
  if(!clipClipboard)return toast('Copy or cut a clip first.');
  const baseLayer=project.layers.findIndex(layer=>layer.id===selectedLayerId);
  const destinations=clipClipboard.items.map(item=>({layerId:project.layers[baseLayer+item.layerOffset]?.id,deckId:project.selectedDeckId,column:selectedColumn+item.columnOffset}));
  try{
    // Preflight the complete transaction so a later out-of-range slot cannot
    // leave a group partially pasted. Actual edits preserve live object identity.
    const trial=validateProject(project),trialClipboard=structuredClone(clipClipboard);
    for(let i=0;i<destinations.length;i++)composition.pasteClip(trial,destinations[i],trialClipboard.items[i].data);
  }catch(error){return toast(error.message,true);}
  const playing=project.layers.map(layer=>layer.activeClipId).filter(Boolean);
  editComposition(()=>{
    selectedClips.clear();
    for(let i=0;i<destinations.length;i++){const clip=composition.pasteClip(project,destinations[i],clipClipboard.items[i].data);selectedClips.add(clip.id);selectedClipId=clip.id;}
    for(const clipId of playing){const found=findClip(clipId);if(found&&!found.layer.activeClipId)found.layer.activeClipId=clipId;}
  });
}
function renderDecks(){$('#decks').innerHTML=project.decks.map(d=>`<button class="deck ${d.id===project.selectedDeckId?'active':''}" data-deck="${d.id}">${esc(d.name)}</button>`).join('');for(const b of $$('[data-deck]')){b.onclick=()=>{project.selectedDeckId=b.dataset.deck;changed();renderDecks();renderLayers();};b.ondblclick=()=>editName(project.decks.find(d=>d.id===b.dataset.deck),'Deck name',()=>{changed();renderDecks();});}}
function range(label,key,value,min,max,step='.01'){return numericField(label,key,value,min,max,step);}
function select(label,key,value,values){return `<div class="select-field"><label for="prop-${key}">${label}</label><select id="prop-${key}" data-prop="${key}">${options(values,value)}</select></div>`;}
function dashboardSection(target,scope){
  const parameters=DASHBOARD_PARAMETERS[scope];
  return `<div class="section dashboard-section"><h3>Dashboard</h3><div class="dashboard-grid">${target.dashboard.map((dial,index)=>{
    const parameter=parameters.find(item=>item[0]===dial.key);
    return `<div class="dashboard-dial" data-dashboard-slot="${index}" title="Drag a parameter label here or choose one below"><label for="dashboard-value-${index}">${esc(parameter?.[1]||`Dial ${index+1}`)}</label><input id="dashboard-value-${index}" data-dashboard-value="${index}" type="range" min="0" max="1" step=".001" value="${dial.value}" ${parameter?'':'disabled'} aria-label="Dashboard ${index+1} ${esc(parameter?.[1]||'unassigned')}"><div class="dashboard-assign"><select data-dashboard-assign="${index}" aria-label="Assign dashboard dial ${index+1}"><option value="">Assign…</option>${parameters.map(item=>`<option value="${item[0]}" ${dial.key===item[0]?'selected':''}>${esc(item[1])}</option>`).join('')}</select><button data-dashboard-clear="${index}" title="Clear dial ${index+1}" ${parameter?'':'disabled'}>×</button></div></div>`;
  }).join('')}</div></div>`;
}
function bindDashboard(host,target,scope){
  const assign=(index,key)=>{
    if(!assignDashboard(target,scope,index,key))return;
    changed();renderInspector();
  };
  for(const dial of $$('[data-dashboard-slot]',host)){
    const index=Number(dial.dataset.dashboardSlot);
    dial.onpointerup=()=>{if(pendingDashboardDrag?.host===host)assign(index,pendingDashboardDrag.key);};
    dial.ondragover=event=>{event.preventDefault();dial.classList.add('drag-over');};
    dial.ondragleave=()=>dial.classList.remove('drag-over');
    dial.ondrop=event=>{event.preventDefault();dial.classList.remove('drag-over');assign(index,event.dataTransfer.getData('application/prism-parameter'));};
  }
  for(const handle of $$('[data-dashboard-source]',host)){
    const key=handle.dataset.dashboardSource;
    if(!DASHBOARD_PARAMETERS[scope].some(item=>item[0]===key))continue;
    handle.onpointerdown=event=>{event.preventDefault();pendingDashboardDrag={host,key};};
    handle.ondragstart=event=>{event.stopPropagation();event.dataTransfer.setData('application/prism-parameter',key);};
  }
  for(const input of $$('[data-dashboard-assign]',host))input.onchange=()=>{
    const index=Number(input.dataset.dashboardAssign);
    if(input.value)assign(index,input.value);
    else {target.dashboard[index]={key:null,value:0};changed();renderInspector();}
  };
  for(const button of $$('[data-dashboard-clear]',host))button.onclick=()=>{
    target.dashboard[Number(button.dataset.dashboardClear)]={key:null,value:0};changed();renderInspector();
  };
  for(const input of $$('[data-dashboard-value]',host))input.oninput=()=>{
    const index=Number(input.dataset.dashboardValue),key=target.dashboard[index]?.key;
    if(!moveDashboard(target,scope,index,Number(input.value)))return;
    input.style.setProperty('--dial-progress',`${Number(input.value)*280}deg`);
    changed('coalesce');
    const slider=host.querySelector(`[data-prop="${key}"]`),number=host.querySelector(`[data-number="${key}"]`);
    const value=target[key]*(slider?.dataset.unit==='pixels'?(key==='x'?project.width:project.height):1);
    if(slider)slider.value=value;
    if(number)number.value=Number(value).toFixed(2);
    if(scope==='composition')syncGlobals();
  };
  for(const input of $$('[data-dashboard-value]',host))input.style.setProperty('--dial-progress',`${Number(input.value)*280}deg`);
}
function renderExtras(target,inspectorTab){
  const mask=target.mask;
  const orders=[['effects','mask','transform'],['effects','transform','mask'],['mask','effects','transform'],['mask','transform','effects'],['transform','effects','mask'],['transform','mask','effects']];
  let html='<div class="section">';
  if(inspectorTab==='clip')html+=`<h3>Media components</h3><div class="row"><label><input id="use-video" type="checkbox" ${target.useVideo?'checked':''}> Video</label><label><input id="use-audio" type="checkbox" ${target.useAudio?'checked':''}> Audio</label><button id="attach-audio" class="icon-btn">Pair audio…</button></div>${componentFields(target)}${select('Video fit','fit',target.fit,['width','height','stretch','original','contain','cover'])}${target.audio?`<div class="component-path" title="${esc(target.audio.path||target.audio.url)}">Audio: ${esc((target.audio.path||'Paired audio').split(/[\\/]/).pop())} · ${target.audio.duration.toFixed(2)} s</div><div class="row"><button id="relink-audio" class="icon-btn">Reconnect audio</button><button id="detach-audio" class="icon-btn">Unpair audio</button></div>`:''}${target.kind==='video'?'<div class="row" style="margin-top:8px"><button id="remove-video" class="icon-btn">Remove video, keep audio</button></div>':''}${desktop&&target.path?'<button id="reveal-media" class="icon-btn" style="margin-top:8px">Show in Explorer</button>':''}`;
  if(inspectorTab!=='composition')html+=`<label class="select-field"><span>Ignore column trigger</span><input id="ignore-column" type="checkbox" ${target.ignoreColumn?'checked':''}></label>`;
  if(inspectorTab==='layer'||inspectorTab==='composition')html+=range('Linked AV','av',target.av,0,1);
  html+=`</div><div class="section"><div class="row"><h3 class="grow">Image mask</h3><button id="choose-mask" class="icon-btn">${mask?'Replace':'Add'} mask…</button></div>${mask?`<div class="component-path" title="${esc(mask.path||'Imported image')}">${esc((mask.path||'Imported mask').split(/[\\/]/).pop())}</div><div class="row"><label><input id="mask-enabled" type="checkbox" ${mask.enabled?'checked':''}> Enabled</label><label><input id="mask-invert" type="checkbox" ${mask.invert?'checked':''}> Invert</label><button id="remove-mask" class="icon-btn">Remove</button></div>`:'<small>Transparent images use their alpha; opaque images use red brightness.</small>'}<label class="select-field"><span>Processing order</span><select id="render-order">${orders.map(order=>`<option value="${order.join(',')}" ${(target.renderOrder||orders[0]).join(',')===order.join(',')?'selected':''}>${order.join(' → ')}</option>`).join('')}</select></label></div>`;
  return html;
}
function inspectorTargets(target,inspectorTab){return inspectorTab==='clip'&&selectedClips.size>1?[...selectedClips].map(clipId=>findClip(clipId)?.clip).filter(Boolean):[target];}
function bindExtras(target,inspectorTab,host,prefix){
  const {$,$$}=inspectorQueries(host,prefix);
  for(const input of $$('[data-channel]'))input.onchange=()=>{for(const clip of inspectorTargets(target,inspectorTab))if(input.dataset.channel!=='alpha'||clip.hasAlpha)clip[input.dataset.channel]=input.checked;changed();};
  for(const input of $$('[data-dimension]'))input.onchange=()=>{const key=input.dataset.dimension;for(const item of inspectorTargets(target,inspectorTab)){if(inspectorTab==='layer'){item[key+'Enabled']=input.checked;if(input.checked&&!item[key])item[key]=project[key];}else item[key]=input.checked?(item[key]||item[key==='width'?'nativeWidth':'nativeHeight']||project[key]):null;}changed();renderInspector();};
  $('#ignore-column')?.addEventListener('change',event=>{target.ignoreColumn=event.target.checked;changed();});
  $('#use-video')?.addEventListener('change',event=>{target.useVideo=event.target.checked;changed();});
  $('#use-audio')?.addEventListener('change',event=>{target.useAudio=event.target.checked;changed();});
  $('#attach-audio')?.addEventListener('click',async()=>{const item=await chooseMedia('audio');if(item)await pairAudio(target,item);});
  $('#detach-audio')?.addEventListener('click',async()=>{const old=target.audio;target.audio=null;target.duration=target.videoDuration||target.duration;target.useAudio=target.kind==='video'||target.kind==='audio';if(old)engine.remove(old.id);try{await engine.prepare(target);}catch(error){toast(error.message,true);}changed();renderInspector();});
  $('#relink-audio')?.addEventListener('click',()=>reconnectComponent(target,'audio'));
  $('#remove-video')?.addEventListener('click',()=>{engine.remove(target.id);if(target.audio){target.path=target.audio.path;target.url=target.audio.url;target.duration=target.audio.duration;target.audio=null;}target.kind='audio';target.useVideo=false;target.useAudio=true;changed();renderAll();});
  $('#reveal-media')?.addEventListener('click',()=>desktop.revealInExplorer(target.path).catch(e=>toast(e.message,true)));
  $('#choose-mask')?.addEventListener('click',async()=>{
    const item=await chooseMedia('image');if(!item)return;
    const mask={id:id(),path:item.path||'',url:item.url,enabled:true,invert:false};
    try{await engine.prepareMask({...target,mask});const old=target.mask;target.mask=mask;if(old)engine.removeMask(old.id);changed();renderInspector();}catch(e){engine.removeMask(mask.id);toast(e.message,true);}
  });
  $('#mask-enabled')?.addEventListener('change',event=>{target.mask.enabled=event.target.checked;changed();});
  $('#mask-invert')?.addEventListener('change',event=>{target.mask.invert=event.target.checked;changed();});
  $('#remove-mask')?.addEventListener('click',()=>{engine.removeMask(target.mask.id);target.mask=null;changed();renderInspector();});
  $('#render-order').onchange=event=>{target.renderOrder=event.target.value.split(',');changed();};
}
function inspectorQueries(host,prefix){
  const selectorFor=selector=>selector.replace(/#([a-zA-Z][\w-]*)/g,(_,value)=>'#'+prefix+value);
  return {$:(selector,parent=host)=>selector==='#inspector'?host:parent.querySelector(selectorFor(selector)),$$:(selector,parent=host)=>[...parent.querySelectorAll(selectorFor(selector))]};
}
function activateInspector(scope){inspectorTab=scope;renderInspector();}
// Rebuild the inspector panels. `only` ('context' or 'clip') rebuilds just
// that panel when the active panel has not changed. Scroll positions are read
// before and written after all DOM changes, so layout runs once, not per panel.
function renderInspector(only=null){
  effectScope=inspectorTab;
  if(inspectorTab!=='clip')contextTab=inspectorTab;
  for(const button of $$('[data-inspector]'))button.classList.toggle('active',button.dataset.inspector===contextTab||button.dataset.inspector==='clip');
  const panels=[[contextTab,'context'],['clip','clip']].filter(([,name])=>!only||only===name)
    .map(([scope,name])=>{const host=$('[data-inspector-panel="'+name+'"]');return {scope,host,scroll:host.scrollTop};});
  for(const {scope,host} of panels){
    const active=scope===inspectorTab;
    host.id=active?'inspector':'secondary-inspector';host.dataset.active=String(active);host.dataset.scope=scope;
    host.onpointerdown=()=>{effectScope=scope;if(browserTab==='effects')renderBrowser();};
    renderInspectorPanel(scope,host,active?'':'secondary-');
  }
  for(const {host,scroll} of panels)if(scroll)host.scrollTop=scroll;
  const clipPanel=$('[data-inspector-panel="clip"]');
  inspectorPlayhead=$('.timeline',clipPanel);
  inspectorTime=$('.time-labels span',clipPanel);
}
function decorateInspector(host,scope){
  const sections=[...host.querySelectorAll(':scope > .section')];
  const titled=name=>sections.find(section=>section.querySelector('h3')?.textContent.startsWith(name));
  const makeSection=(title,before)=>{const section=document.createElement('div');section.className='section';const heading=document.createElement('h3');heading.textContent=title;section.append(heading);host.insertBefore(section,before);return section;};
  const moveField=(key,section)=>{const field=host.querySelector('[data-prop="'+key+'"]')?.closest('.field, .select-field');if(field)section.append(field);};
  if(scope==='composition'){
    const settings=titled('Composition settings');
    if(settings){
      const main=makeSection('Composition',settings);moveField('av',main);
      const audio=makeSection('Audio',settings);audio.classList.add('audio-section');moveField('masterVolume',audio);moveField('pan',audio);
      const video=makeSection('Video',settings);moveField('masterOpacity',video);
      const crossfader=makeSection('CrossFader',settings);for(const key of ['crossfader','crossfaderBlend','crossfaderCurve','crossfaderBehaviour'])moveField(key,crossfader);
      host.append(settings);
    }
  }
  if(scope==='clip'){
    const transportSection=titled('Transport'),transform=titled('Transform'),video=titled('Video & audio'),components=titled('Media components');
    if(transportSection){
      const advanced=makeSection('Trigger & playback',null);
      for(const field of [...transportSection.querySelectorAll(':scope > .select-field')])advanced.append(field);
      for(const key of ['inPoint','outPoint'])moveField(key,advanced);
      for(const heading of [...transportSection.querySelectorAll(':scope > h3')].filter(item=>!item.textContent.startsWith('Transport'))){
        const buttons=heading.nextElementSibling,section=makeSection(heading.textContent.startsWith('BeatLoopr')?'BeatLoopr':'Cue points',null);
        heading.remove();if(buttons?.classList.contains('cue-buttons'))section.append(buttons);
      }
      const timeline=transportSection.querySelector('.timeline'),time=transportSection.querySelector('.time-labels'),buttons=transportSection.querySelector('.transport-buttons');
      if(timeline&&buttons){transportSection.insertBefore(timeline,buttons);transportSection.insertBefore(time,buttons);}
    }
    if(video){video.querySelector('h3').textContent='Video';const audio=makeSection('Audio',null);audio.classList.add('audio-section');moveField('volume',audio);moveField('pan',audio);}
    if(components&&transform)host.insertBefore(components,transform);
  }
  for(const section of host.querySelectorAll('.section')){
    const heading=section.querySelector('h3');if(!heading)continue;
    if(/Transform|Media components|Video/.test(heading.textContent))section.classList.add('video-section');
    const content=document.createElement('div');content.className='section-body';
    const first=heading.parentElement.classList.contains('row')?heading.parentElement:heading;
    const header=document.createElement('div');header.className='section-heading';
    section.insertBefore(header,first);header.append(first);
    for(const child of [...section.childNodes])if(child!==header)content.append(child);
    section.append(content);
    heading.tabIndex=0;heading.setAttribute('role','button');heading.setAttribute('aria-expanded','true');
    const key=scope+':'+heading.textContent;
    if(collapsedSections.has(key)){section.classList.add('collapsed');heading.setAttribute('aria-expanded','false');}
    const toggle=()=>{const collapsed=section.classList.toggle('collapsed');if(collapsed)collapsedSections.add(key);else collapsedSections.delete(key);heading.setAttribute('aria-expanded',String(!collapsed));};
    heading.onclick=toggle;heading.onkeydown=event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();event.stopPropagation();toggle();}};
  }
}
function renderInspectorPanel(inspectorTab,host,prefix){
  const {$,$$}=inspectorQueries(host,prefix);
  const layer=currentLayer(),clip=currentClip(),group=currentGroup(),target=inspectorTarget(inspectorTab);
  if(!target){$('#inspector').innerHTML=inspectorTab==='group'?'<div class="empty">The selected layer is not in a group.<br><br>Right-click a layer name and choose<br>Group → New to create one.</div>':'<div class="empty">Select a clip to see its transport,<br>transform, and effect controls.<br><br>Right-click selects without triggering.</div>';return;}
  let html=`<div class="section"><div class="row"><h2 class="grow">${esc(target.name)}</h2><button id="rename" class="icon-btn">Rename</button>${inspectorTab==='clip'?'<button id="remove-clip" class="icon-btn danger">Remove</button>':''}${inspectorTab==='group'?'<button id="ungroup" class="icon-btn">Ungroup</button>':''}</div></div>`;
  html+=dashboardSection(target,inspectorTab);
  if(inspectorTab==='clip')html+=`<div class="section clip-persistence"><h3>Deck behavior</h3><label><input id="clip-persistent" type="checkbox" ${clip.persistent?'checked':''}> Persistent across decks</label><small>Shows this clip in the same layer and column on every deck. Covered clips stay in their original deck.</small></div>`;
  if(inspectorTab==='clip')html+=`<div class="section clip-label-color"><h3>Clip label</h3><div class="row"><label>Highlight <input id="clip-label-color" type="color" value="${esc(clip.labelColor||'#8affd7')}"></label><button id="clear-clip-label" class="icon-btn">Clear color</button></div></div>`;
  if(inspectorTab==='clip')html+=`<div class="section"><h3>Snapshot</h3><button id="snapshot-clip" class="icon-btn">Save clip frame as PNG</button></div>`;
  if(inspectorTab==='clip')html+=`${clipTransportHTML(clip)}${select('Restart behavior','trigger',clip.trigger,['restart','continue','piano'])}${select('Trigger style','triggerStyle',clip.triggerStyle,['inherit','normal','piano'])}${select('Clip target','clipTarget',clip.clipTarget,['inherit','own','selected','free'])}<div class="select-field"><label>Beat snap</label><select id="clip-quantize">${[[null,'Composition'],[0,'Immediate'],[.25,'1/4 beat'],[1,'1 beat'],[4,'1 bar'],[8,'2 bars']].map(([v,label])=>`<option value="${v===null?'inherit':v}" ${clip.quantize===v?'selected':''}>${label}</option>`).join('')}</select></div>${select('Autopilot','autoPilot',clip.autoPilot,['inherit','off','next','previous','random'])}${range('In point','inPoint',clip.inPoint,0,.99)}${range('Out point','outPoint',clip.outPoint,.01,1)}<h3 style="margin-top:14px">BeatLoopr</h3><div class="cue-buttons">${[0,4,2,1,.5,.25].map(v=>`<button data-beat-loop="${v}" class="${clip.beatLoop===v?'active':''}">${v||'Off'}</button>`).join('')}</div><h3 style="margin-top:14px">Cue points <small>Shift-click to set</small></h3><div class="cue-buttons">${clip.cues.map((c,i)=>`<button data-cue="${i}" title="${(c*100).toFixed(1)}%">${i+1} · ${(c*100).toFixed(0)}%</button>`).join('')}</div></div><div class="section"><h3>Video & audio</h3>${range('Opacity','opacity',clip.opacity,0,1)}${range('Volume','volume',clip.volume,0,4)}${range('Pan','pan',clip.pan,-1,1)}${clip.kind==='source'&&!sourceDefinition(clip.source)?.params?.some(param=>param.key==='color')?`<div class="select-field"><label>Color</label><input type="color" id="source-color" value="${esc(clip.color)}"></div>`:''}${clip.kind!=='source'?'<div class="row"><button id="relink-clip">Reconnect media</button></div>':''}${clip.path?`<small title="${esc(clip.path)}">${esc(clip.path.split(/[\\/]/).pop())}</small>`:''}</div>`;
  if(inspectorTab==='clip'&&clip.kind==='source')html+=sourceParamsHTML(clip);
  if(inspectorTab==='clip'&&clip.kind==='effect')html+='<div class="section"><h3>Effect clip</h3><small>Effects on this clip process every layer beneath it while it plays, like an adjustment layer. Use the layer opacity or a transition to fade it in.</small></div>';
  if(inspectorTab==='group')html+=`<div class="section"><h3>Group mixing</h3>${range('Video','opacity',group.opacity,0,1)}${range('Audio','volume',group.volume,0,1)}${range('Pan','pan',group.pan,-1,1)}${range('Speed','speed',group.speed,0,4)}<div class="select-field"><label for="prop-blend">Blend mode</label><select id="prop-blend" data-prop="blend">${blendOptions(group.blend)}</select></div>${select('Crossfader','crossfader',group.crossfader,['none','A','B'])}<div class="row"><label><input id="group-bypass" type="checkbox" ${group.bypass?'checked':''}> Bypass</label><label><input id="group-solo" type="checkbox" ${group.solo?'checked':''}> Solo</label><button id="group-clear" class="icon-btn">Eject all</button></div><small>${project.layers.filter(item=>item.groupId===group.id).length} layers. What happens in the group stays in the group.</small></div>`;
  if(inspectorTab==='layer')html+=`<div class="section"><h3>Layer options</h3>${select('Mask mode','maskMode',layer.maskMode||'none',['none','luma','alpha','luma-invert','alpha-invert'])}<div class="select-field"><label for="layer-group">Group</label><select id="layer-group"><option value="">None</option>${(project.groups||[]).map(item=>`<option value="${item.id}" ${layer.groupId===item.id?'selected':''}>${esc(item.name)}</option>`).join('')}<option value="new">New group…</option></select></div><div class="row wrap"><label><input id="layer-locked" type="checkbox" ${layer.locked?'checked':''}> Lock content</label><button id="layer-previous" class="icon-btn" title="Previous clip">⏮ Prev</button><button id="layer-next" class="icon-btn" title="Next clip">Next ⏭</button><button id="duplicate-layer" class="icon-btn">Duplicate</button><button id="clear-layer-clips" class="icon-btn">Clear clips</button></div></div>`;
  if(inspectorTab==='layer')html+=`<div class="section"><h3>Layer mixing</h3>${range('Video','opacity',layer.opacity,0,1)}${range('Audio','volume',layer.volume,0,1)}${range('Pan','pan',layer.pan,-1,1)}<div class="select-field"><label for="prop-blend">Blend mode</label><select id="prop-blend" data-prop="blend">${blendOptions(layer.blend)}</select></div>${select('Crossfader','group',layer.group,['none','A','B'])}${range('Transition (s)','transition',layer.transition,0,10,'.1')}<div class="select-field"><label for="prop-transitionMode">Transition mode</label><select id="prop-transitionMode" data-prop="transitionMode">${blendOptions(layer.transitionMode,true)}</select></div>${select('Autopilot','autoPilot',layer.autoPilot,['off','next','previous','random'])}<div class="row"><button id="move-layer-up">Move up</button><button id="move-layer-down">Move down</button><button id="remove-layer" class="danger">Remove layer</button></div></div>`;
  if(inspectorTab==='composition')html+=compositionSettings(project,range);
  html+=transformFields(target,project,inspectorTab)+renderExtras(target,inspectorTab)+effectStackHTML(target)+(target.kind==='effect'?'':effectStackHTML(target,{audio:true}));host.innerHTML=html.replace(/\b(id|for)="([^"]+)"/g,(_,attribute,value)=>attribute+'="'+prefix+value+'"');bindExtras(target,inspectorTab,host,prefix);
  const targets=inspectorTargets(target,inspectorTab);
  const setProperty=(key,value,input)=>{
    if(input.type==='range'||input.type==='number'||input.dataset.number!==undefined){
      if(value===''||!Number.isFinite(Number(value)))return;
      value=Math.max(Number(input.getAttribute('min')),Math.min(Number(input.getAttribute('max')),Number(value)));
    }
    if(input.dataset.unit==='pixels')value/=input.dataset.prop==='x'||input.dataset.number==='x'?project.width:project.height;
    for(const item of targets){let next=value;if(key==='inPoint')next=Math.min(next,item.outPoint-.001);if(key==='outPoint')next=Math.max(next,item.inPoint+.001);item[key]=next;syncDashboard(item,inspectorTab,key);}
    const slider=$('[data-prop="'+key+'"]',$('#inspector')),number=$('[data-number="'+key+'"]',$('#inspector'));
    const display=typeof target[key]==='number'?target[key]*(input.dataset.unit==='pixels'?(key==='x'?project.width:project.height):1):target[key];if(slider)slider.value=display;if(number&&number!==document.activeElement)number.value=Number(display).toFixed(2);
    for(const dial of $$('[data-dashboard-value]',host))if(target.dashboard[Number(dial.dataset.dashboardValue)]?.key===key){dial.value=target.dashboard[Number(dial.dataset.dashboardValue)].value;dial.style.setProperty('--dial-progress',`${Number(dial.value)*280}deg`);}
    changed('coalesce');if(inspectorTab!=='clip')syncGlobals();
  };
  for(const input of $$('[data-prop]',$('#inspector'))){
    input.oninput=()=>setProperty(input.dataset.prop,input.value,input);
    if(input.type==='range'){const reset=event=>{event.preventDefault();const key=input.dataset.prop;const defaults={opacity:1,volume:1,masterOpacity:1,masterVolume:1,av:1,scale:1,speed:1,outPoint:1,crossfader:.5,width:target.nativeWidth||project.width,height:target.nativeHeight||project.height};setProperty(key,defaults[key]??0,input);};input.ondblclick=reset;input.oncontextmenu=reset;$('label[for="'+input.id+'"]',$('#inspector')).oncontextmenu=reset;}
  }
  for(const input of $$('[data-number]',$('#inspector')))input.onchange=()=>{setProperty(input.dataset.number,input.value,input);input.value=Number(target[input.dataset.number]*(input.dataset.unit==='pixels'?(input.dataset.number==='x'?project.width:project.height):1)).toFixed(2);};
  $('#rename').onclick=()=>editName(target,'Name',()=>{changed();renderAll();});
  bindEffectStacks(host,target,{getProject:()=>project,toast,prompt:promptText,changed:structural=>{changed(structural?true:'coalesce');if(structural)renderInspector();if(structural&&browserTab==='effects')renderBrowser();},onBrowse:kind=>{activateInspector(inspectorTab);browserTab='effects';effectKind=kind;renderBrowser();}});
  for(const zone of $$('[data-effect-drop]',host)){zone.ondragover=event=>{if(event.dataTransfer.types.includes('application/prism-effect')){event.preventDefault();zone.classList.add('drag-over');}};zone.ondragleave=()=>zone.classList.remove('drag-over');zone.ondrop=event=>{zone.classList.remove('drag-over');const data=event.dataTransfer.getData('application/prism-effect');if(!data)return;event.preventDefault();addEffect(target,JSON.parse(data),event.altKey);};}
  if(inspectorTab==='group'){
    $('#ungroup').onclick=()=>editComposition(()=>{composition.ungroup(project,group.id);selectedGroupId=null;inspectorTab='layer';});
    $('#group-bypass').onchange=event=>{group.bypass=event.target.checked;changed();renderLayers();};
    $('#group-solo').onchange=event=>{group.solo=event.target.checked;changed();renderLayers();};
    $('#group-clear').onclick=()=>{for(const item of project.layers)if(item.groupId===group.id){triggerRequests.delete(item.id);transport.stop(item.id);}renderLayers();};
  }
  if(inspectorTab==='layer'){
    $('#layer-group').onchange=event=>{const value=event.target.value;editComposition(()=>{if(value==='new')selectedGroupId=composition.createGroupForLayer(project,layer.id).id;else composition.setLayerGroup(project,layer.id,value||null);});};
    $('#layer-locked').onchange=event=>{layer.locked=event.target.checked;changed();renderLayers();};
    $('#layer-previous').onclick=()=>stepLayerClip(layer,-1);$('#layer-next').onclick=()=>stepLayerClip(layer,1);
    $('#duplicate-layer').onclick=()=>editComposition(()=>{selectedLayerId=composition.duplicateLayer(project,layer.id).id;});
    $('#clear-layer-clips').onclick=async()=>{if(await confirmDialog('Clear all clips in this layer?',`Every deck's clips in ${layer.name} are removed. Undo restores them.`,'Clear clips'))editComposition(()=>{transport.stop(layer.id);composition.clearLayerClips(project,layer.id);});};
  }
  if(clip&&inspectorTab==='clip'){
    for(const b of $$('[data-direction]'))b.onclick=()=>{clip.direction=+b.dataset.direction;clip.paused=false;changed();renderInspector();};

    $('#retrigger').onpointerdown=event=>{if(event.button!==0||!transport.isPiano(clip))return;const inputId=id(),owner=findClip(clip.id).layer,held={layerId:owner.id,clipId:clip.id,inputId};heldPointers.set(event.pointerId,held);trigger(owner,clip,()=>heldPointers.get(event.pointerId)===held,{inputId,selectedLayerId});};
    $('#retrigger').onclick=()=>{if(!transport.isPiano(clip))trigger(findClip(clip.id).layer,clip);};
    $('#timeline').oninput=e=>{const layer=playingLayerFor(clip.id)||findClip(clip.id).layer;if(layer.activeClipId===clip.id)transport.seek(layer.id,+e.target.value);else toast('Trigger this clip before moving its live playhead.');};
    bindClipTransport(clip,$);
    $('#clip-quantize').onchange=e=>{clip.quantize=e.target.value==='inherit'?null:+e.target.value;changed();};
    for(const b of $$('[data-beat-loop]'))b.onclick=()=>{clip.beatLoop=+b.dataset.beatLoop;changed();renderInspector();};

    for(const b of $$('[data-cue]'))b.onclick=e=>{const l=playingLayerFor(clip.id)||findClip(clip.id).layer;if(l.activeClipId!==clip.id)return toast('Trigger this clip before using its cue points.');if(e.shiftKey){transport.setCue?.(l.id,+b.dataset.cue);changed();renderInspector();}else {transport.cue?.(l.id,+b.dataset.cue);changed();renderInspector();}};
    $('#relink-clip')?.addEventListener('click',()=>reconnectComponent(clip,'video'));
    $('#source-color')?.addEventListener('input',e=>{clip.color=e.target.value;changed();});
    $('#snapshot-clip').onclick=()=>captureSnapshot('clip');
    $('#clip-persistent').onchange=event=>{for(const item of targets)setPersistent(project,item.id,event.target.checked);changed();renderLayers();renderInspector();};
    $('#clip-label-color').oninput=event=>{for(const item of targets)item.labelColor=event.target.value;changed();renderLayers();};
    $('#clear-clip-label').onclick=()=>{for(const item of targets)item.labelColor=null;changed();renderLayers();renderInspector();};
    $('#remove-clip').onclick=()=>{const {layer}=findClip(clip.id);if(layer.activeClipId===clip.id)transport.stop(layer.id);for(const clips of Object.values(layer.clips)){const i=clips.findIndex(c=>c?.id===clip.id);if(i>=0)clips[i]=null;}engine.remove(clip.id);selectedClipId=null;changed();renderAll();};
  }
  if(inspectorTab==='layer'){
    $('#remove-layer').onclick=()=>{if(project.layers.length===1)return toast('Keep at least one layer.');transport.stop(layer.id);for(const c of Object.values(layer.clips).flat())if(c)engine.remove(c.id);project.layers=project.layers.filter(l=>l!==layer);selectedLayerId=project.layers[0].id;changed();renderAll();};
    for(const [button,offset] of [['#move-layer-up',1],['#move-layer-down',-1]])$(button).onclick=()=>{const i=project.layers.indexOf(layer),j=i+offset;if(j<0||j>=project.layers.length)return;[project.layers[i],project.layers[j]]=[project.layers[j],project.layers[i]];changed();renderLayers();};
  }
  decorateInspector(host,inspectorTab);
  addPropertyCogs(host,inspectorTab,target);
  decorateAnimations(host,animationContext);
  bindDashboard(host,target,inspectorTab);
  if(inspectorTab==='composition'){
    $('#composition-description').onchange=event=>{project.description=event.target.value;changed();};
    const resize=(width,height)=>{width=Number(width);height=Number(height);if(!Number.isInteger(width)||!Number.isInteger(height)||width<64||height<64||width>8192||height>8192)return toast('Use whole-number dimensions from 64 to 8192 pixels.',true);try{engine.resize(width,height);project.width=width;project.height=height;changed();syncGlobals();renderInspector();}catch(error){toast(error.message,true);}};
    $('#composition-size').onchange=event=>resize(...event.target.value.split(','));
    $('#apply-composition-size').onclick=()=>resize($('#composition-width').value,$('#composition-height').value);
    $('#save-as').onclick=()=>saveProject(true);
  }
}

function grouped(definitions,query){
  const groups=new Map();
  for(const definition of definitions){
    if(definition.hidden||(definition.legacy&&definition.kind!=='canvas'&&!['plasma','grid','rings','noise','solid'].includes(definition.id)))continue;
    if(query&&!`${definition.name} ${definition.category} ${definition.id}`.toLowerCase().includes(query))continue;
    if(!groups.has(definition.category))groups.set(definition.category,[]);
    groups.get(definition.category).push(definition);
  }
  return [...groups].map(([category,items])=>[category,items.sort((a,b)=>a.name.localeCompare(b.name))]).sort((a,b)=>a[0].localeCompare(b[0]));
}
function effectsBrowserHTML(){
  const query=effectSearch.trim().toLowerCase(),audio=effectKind==='audio',presets=readPresets();
  const definitions=audio?listAudioEffects():listEffects();
  const scopeName=effectScope==='composition'?'composition':effectScope==='group'?'group':effectScope==='layer'?'layer':'clip';
  const items=grouped(definitions,query).map(([category,list])=>`<details class="browser-group" open><summary>${esc(category)} <span class="muted">${list.length}</span></summary>${list.map(definition=>{
    const own=presets[`${audio?'audio:':''}${definition.id}`]||[];
    return `<div class="browser-item fx-item" data-add-effect="${esc(definition.id)}" data-effect-kind="${audio?'audio':'video'}" draggable="true" title="Click to add to the selected ${scopeName}. Drag onto a clip, layer or panel; Alt-drop adds it at 0% opacity."><span class="pill">${audio?'AFX':'FX'}</span><strong>${esc(definition.name)}</strong><span class="spacer"></span><span class="muted">＋</span></div>${own.map((preset,index)=>`<div class="browser-item fx-item preset" data-add-effect="${esc(definition.id)}" data-effect-kind="${audio?'audio':'video'}" data-preset="${index}" draggable="true"><span class="muted">↳</span>${esc(preset.name)}</div>`).join('')}`;
  }).join('')}</details>`).join('');
  return `<div class="browser-tools"><input id="effect-search" type="search" placeholder="Search effects (Ctrl+/)" value="${esc(effectSearch)}" aria-label="Search effects"><div class="segmented"><button data-effect-kind-tab="video" class="${audio?'':'active'}">Video</button><button data-effect-kind-tab="audio" class="${audio?'active':''}">Audio</button></div></div>
    <div class="browser-note">Adds to the selected <strong>${scopeName}</strong>. Effects process top to bottom. ${audio?'Audio effects mix with Dry/Wet.':'Each effect has its own opacity and blend mode.'}</div>${items||'<p class="browser-note">No effects match.</p>'}
    ${audio?'':`<div class="section"><h3>ISF shaders</h3><p class="browser-note">Import Interactive Shader Format (.fs) effects and generators, e.g. from the ISF community library.</p><div class="row"><button id="load-isf-files">Import .fs files…</button>${desktop?.scanISFFolder?'<button id="load-isf-folder">Import folder…</button>':''}</div></div>`}`;
}
function sourcesBrowserHTML(){
  const query=sourceSearch.trim().toLowerCase();
  const special=['capture','screen','router'];
  const items=grouped(listSources().filter(definition=>!special.includes(definition.id)),query).map(([category,list])=>`<details class="browser-group" open><summary>${esc(category)} <span class="muted">${list.length}</span></summary>${list.map(definition=>`<div class="browser-item" data-source="${esc(definition.id)}" draggable="true" title="Drag to a clip slot or click to add to the selected layer"><div class="source-icon clip-art ${esc(definition.id)}"></div><div><strong>${esc(definition.name)}</strong><small>${esc(definition.description||definition.category)}</small></div><span class="spacer"></span><span class="muted">＋</span></div>`).join('')}</details>`).join('');
  const live=`<details class="browser-group" open><summary>Live inputs &amp; routing</summary>
    ${captureDevices.map(device=>`<div class="browser-item" data-source="capture" data-source-params="${esc(JSON.stringify({device:device.deviceId}))}" data-source-name="${esc(device.label||'Camera')}" draggable="true"><span class="pill">CAM</span><strong>${esc(device.label||'Capture device')}</strong></div>`).join('')}
    <div class="browser-item" data-source="capture" data-source-name="Capture device" draggable="true"><span class="pill">CAM</span><strong>Default capture device</strong></div>
    <div class="browser-item" data-source="screen" data-source-name="Screen capture" draggable="true"><span class="pill">SCR</span><strong>Screen capture</strong></div>
    <div class="browser-item" data-source="router" data-source-name="Video Router" draggable="true"><span class="pill">RT</span><strong>Video Router</strong><small>Layers below, or a chosen layer/group</small></div>
    <div class="browser-item" data-source="effect-clip" data-source-name="Effect clip" draggable="true"><span class="pill">FX</span><strong>Effect clip</strong><small>Adjustment layer for effects</small></div>
    <button id="refresh-devices" class="icon-btn">Find capture devices</button></details>`;
  return `<div class="browser-tools"><input id="source-search" type="search" placeholder="Search sources" value="${esc(sourceSearch)}" aria-label="Search sources"></div><div class="browser-note">Drag a source into a clip slot, or click to add it to the selected layer.</div>${live}${items}`;
}
async function importISFTexts(files){
  let added=0;const problems=[];
  const {parseISF}=await import('./fx/isf.js');
  for(const file of files){
    try{const {definition,kind,warnings}=parseISF(file.text,{fileName:file.name});(kind==='source'?registerSource:registerEffect)(definition);engine.prewarm([definition],{kind:kind==='source'?'source':'effect'});added++;if(warnings.length)problems.push(`${file.name}: ${warnings[0]}`);}
    catch(error){problems.push(`${file.name}: ${error.message}`);}
  }
  renderBrowser();
  toast(`Imported ${added} ISF shader${added===1?'':'s'}.${problems.length?` ${problems.length} note${problems.length===1?'':'s'}: ${problems.slice(0,2).join(' · ')}`:''}`,added===0&&problems.length>0);
  return added;
}
async function refreshCaptureDevices(){
  try{
    if(!navigator.mediaDevices?.enumerateDevices)throw new Error('Capture devices are unavailable here.');
    let devices=(await navigator.mediaDevices.enumerateDevices()).filter(device=>device.kind==='videoinput');
    if(devices.length&&!devices.some(device=>device.label)){const stream=await navigator.mediaDevices.getUserMedia({video:true});stream.getTracks().forEach(track=>track.stop());devices=(await navigator.mediaDevices.enumerateDevices()).filter(device=>device.kind==='videoinput');}
    captureDevices=devices;renderBrowser();toast(`${devices.length} capture device${devices.length===1?'':'s'} found.`);
  }catch(error){toast(`Capture devices unavailable: ${error.message}`,true);}
}
function renderBrowser(){
  for(const b of $$('[data-browser]'))b.classList.toggle('active',b.dataset.browser===browserTab);
  if(browserTab==='sources')$('#browser').innerHTML=sourcesBrowserHTML();
  if(browserTab==='effects')$('#browser').innerHTML=effectsBrowserHTML();
  if(browserTab==='files'){fileBrowser.render($('#browser'));return;}else fileBrowser.detach();
  if(browserTab==='controls')$('#browser').innerHTML=shortcuts.panelHTML()+controlExtrasHTML()+`<div class="section"><h3>Performance controls</h3><p class="browser-note">Number keys 1–0 trigger the selected layer; Shift triggers a column. Q–I trigger the top layer; A–K the middle; Z–comma the bottom. Space pauses. Escape clears blackout.</p><button id="enable-midi">${midiAccess?'MIDI connected':'Enable MIDI input'}</button><p id="midi-status" class="browser-note">${midiAccess?[...midiAccess.inputs.values()].map(x=>esc(x.name)).join(', ')||'No MIDI inputs detected':'Connect a controller, then enable MIDI.'}</p></div><div class="section"><h3>MIDI learn</h3><select id="learn-target"><option value="crossfader">Crossfader</option><option value="masterOpacity">Master video</option><option value="masterVolume">Master audio</option>${project.layers.map((l,i)=>`<option value="layer:${l.id}:opacity">${esc(l.name)} video</option>`).join('')}${Array.from({length:project.columns||8},(_,i)=>`<option value="column:${i}">Column ${i+1}</option>`).join('')}</select><button id="midi-learn" class="icon-btn">Learn</button><div id="mappings">${project.mappings.map((m,i)=>`<div class="mapping"><small class="grow">${esc(m.target)} ← ${m.type} ${m.number}</small><button data-unmap="${i}" class="icon-btn">×</button></div>`).join('')}</div></div>${desktop?.startOSC?'<div class="section"><h3>OSC input</h3><div class="row"><input id="osc-port" aria-label="OSC port" type="number" min="1024" max="65535" value="7000" style="width:80px"><button id="osc-start">Start OSC</button><button id="osc-stop">Stop</button></div><p class="browser-note">Local UDP input. /composition/video/fadeout/values, /layer1/audio/pan/values, /layer1/clip1/connect, /layer1/video/opacity/values.</p></div>':''}`;
  const sourceExtra=item=>({params:item.dataset.sourceParams?JSON.parse(item.dataset.sourceParams):undefined,name:item.dataset.sourceName});
  for(const item of $$('[data-source]')){item.onpointerenter=()=>{const definition=sourceDefinition(item.dataset.source);if(definition?.glsl)engine.prewarm([definition],{kind:'source',priority:true});};item.onclick=()=>addSource(item.dataset.source,currentLayer(),undefined,sourceExtra(item));item.ondragstart=e=>{e.dataTransfer.setData('application/prism-source',item.dataset.source);e.dataTransfer.setData('application/prism-source-extra',JSON.stringify(sourceExtra(item)));};}
  for(const item of $$('[data-add-effect]')){
    const data={type:item.dataset.addEffect,kind:item.dataset.effectKind||'video',...(item.dataset.preset!==undefined?{preset:Number(item.dataset.preset)}:{})};
    item.onclick=event=>{if(inspectorTab!==effectScope){inspectorTab=effectScope;renderInspector();}addEffect(inspectorTarget(effectScope),data,event.altKey);};
    item.ondragstart=event=>{event.dataTransfer.setData('application/prism-effect',JSON.stringify(data));event.dataTransfer.effectAllowed='copy';};
    if(data.kind==='video'){item.onpointerenter=()=>engine.prewarm([effectDefinition(data.type)],{priority:true});item.ondblclick=()=>previewEffect(data);}
  }
  const search=$('#effect-search')||$('#source-search');
  if(search){search.oninput=()=>{if(search.id==='effect-search')effectSearch=search.value;else sourceSearch=search.value;const position=search.selectionStart;renderBrowser();const next=$('#'+search.id);next.focus();next.setSelectionRange(position,position);};}
  for(const button of $$('[data-effect-kind-tab]'))button.onclick=()=>{effectKind=button.dataset.effectKindTab;renderBrowser();};
  $('#refresh-devices')?.addEventListener('click',refreshCaptureDevices);
  $('#load-isf-files')?.addEventListener('click',()=>{const input=document.createElement('input');input.type='file';input.accept='.fs,.frag,.glsl';input.multiple=true;input.onchange=async()=>importISFTexts(await Promise.all([...input.files].map(async file=>({name:file.name,text:await file.text()}))));input.click();});
  $('#load-isf-folder')?.addEventListener('click',async()=>{try{const result=await desktop.scanISFFolder();if(result)await importISFTexts(result.files);if(result?.folder&&!preferences.isfFolders.includes(result.folder))preferences=writePreferences({...preferences,isfFolders:[...preferences.isfFolders,result.folder]});}catch(error){toast(`ISF import failed: ${error.message}`,true);}});
  if(browserTab==='controls')shortcuts.bindPanel($('#browser'),{prompt:promptText,render:renderBrowser});
  $('#import-media')?.addEventListener('click',()=>importFiles());
  for(const item of $$('[data-library]'))item.onclick=()=>placeMedia(mediaLibrary[+item.dataset.library],currentLayer());
  $('#enable-midi')?.addEventListener('click',enableMidi);
  $('#midi-learn')?.addEventListener('click',()=>{learning=$('#learn-target').value;toast('Move a MIDI control or press a note to assign it.');});
  for(const b of $$('[data-unmap]'))b.onclick=()=>{project.mappings.splice(+b.dataset.unmap,1);changed();renderBrowser();};
  $('#osc-start')?.addEventListener('click',async()=>{try{const result=await desktop.startOSC(+$('#osc-port').value);toast(`OSC listening on port ${result?.port||$('#osc-port').value}`);}catch(e){toast(e.message,true);}});
  $('#osc-stop')?.addEventListener('click',async()=>{await desktop.stopOSC();toast('OSC stopped.');});
  if(browserTab==='controls')bindControlExtras();
}

function bindStatic(){
  for(const [selector,key] of [['#project-name','name'],['#bpm','bpm'],['#quantize','quantize'],['#global-speed','speed'],['#crossfader','crossfader'],['#master-opacity','masterOpacity'],['#master-volume','masterVolume']])$(selector).oninput=e=>{project[key]=key==='name'?e.target.value:+e.target.value;markFaders($('.monitor-footer'));if(key==='bpm'){project.bpm=Math.max(20,Math.min(300,project.bpm||120));linkTempoChanged();}$('#speed-value').textContent=project.speed.toFixed(2)+'×';changed('coalesce');};
  $('#pause').onclick=()=>{project.paused=!project.paused;changed();syncGlobals();};
  const direction=(mode,pin=false)=>{if(pin&&project.directionPin===mode)project.directionPin=null;else transport.setGlobalDirection(mode,{pin});changed();syncGlobals();renderInspector();};
  for(const button of $$('[data-global-direction]')){button.onclick=()=>direction(button.dataset.globalDirection);button.oncontextmenu=event=>{event.preventDefault();direction(button.dataset.globalDirection,true);};}
  $('#pause').oncontextmenu=event=>{event.preventDefault();direction('pause',true);};
  $('#bypass-all').onclick=()=>{project.bypass=!project.bypass;changed();syncGlobals();};
  $('#preferences').onclick=preferencesDialog;
  $('#blackout').onclick=()=>{project.blackout=!project.blackout;syncGlobals();};
  $('#clear-all').onclick=()=>{triggerRequests.clear();for(const l of project.layers)transport.stop(l.id);renderLayers();};
  $('#resync').onclick=()=>transport.resync?.(now());
  $('#tap').onclick=()=>{const t=now();if(t-(tapTimes.at(-1)||0)>2)tapTimes=[];tapTimes.push(t);if(tapTimes.length>6)tapTimes.shift();if(tapTimes.length>1){project.bpm=Math.max(20,Math.min(300,60*(tapTimes.length-1)/(t-tapTimes[0])));$('#bpm').value=project.bpm.toFixed(1);linkTempoChanged();changed();}};
  $('#link').onclick=()=>toggleLink();
  $('#link').oncontextmenu=event=>{event.preventDefault();showMenu(event,[[link.enabled?'Disable Link':'Enable Link',()=>toggleLink()],[`${preferences.linkStartStop?'✓':'\u2007'} Start/stop sync (pause with the session)`,async()=>{preferences=writePreferences({...preferences,linkStartStop:!preferences.linkStartStop});await desktop.linkStartStopSync(preferences.linkStartStop).catch(()=>{});}],['Start session playing',()=>desktop.linkPlaying(true),!link.enabled],['Stop session',()=>desktop.linkPlaying(false),!link.enabled]]);};
  for(const [selector,side] of [['#cross-a','A'],['#cross-b','B']]){const button=$(selector);button.onpointerdown=event=>{if(event.button===0)crossfaderButton(side,true);};button.onpointerup=button.onpointerleave=()=>crossfaderButton(side,false);button.onkeydown=event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();crossfaderButton(side,true);}};button.onkeyup=event=>{if(event.key==='Enter'||event.key===' ')crossfaderButton(side,false);};}
  $('#layer-bank').onscroll=e=>{$('#column-viewport').scrollLeft=e.target.scrollLeft;};
  for(const b of $$('[data-inspector]'))b.onclick=()=>{inspectorTab=b.dataset.inspector;renderInspector();if(browserTab==='effects')renderBrowser();};
  for(const b of $$('[data-browser]'))b.onclick=()=>{browserTab=b.dataset.browser;renderBrowser();};
  $('#previous-column').onclick=()=>stepColumn(-1);$('#next-column').onclick=()=>stepColumn(1);
  $('#add-layer').onclick=()=>editComposition(()=>{selectedLayerId=composition.addLayer(project).id;});
  $('#insert-layer').onclick=()=>editComposition(()=>{selectedLayerId=composition.addLayer(project,undefined,project.layers.indexOf(currentLayer())).id;});
  $('#add-deck').onclick=()=>editComposition(()=>{project.selectedDeckId=composition.addDeck(project).id;});
  $('#deck-actions').onclick=deckActions;$('#column-actions').onclick=columnActions;
  $('#copy-clip').onclick=()=>copySelection(false);$('#cut-clip').onclick=()=>copySelection(true);$('#paste-clip').onclick=pasteSelection;
  $('#save-project').onclick=()=>saveProject();$('#open-project').onclick=openProject;
  $('#new-project').onclick=async()=>{if(dirty){const ok=await confirmDialog('Create a new composition?','Your recovery copy will be kept until the new composition changes. Save the current composition first if you want to keep it.','Create new');if(!ok)return;}await desktop?.resetProjectPath?.();loadProject(createProject());};
  $('#record').onclick=toggleRecording;$('#output').onclick=openOutput;
  $('#snapshot-output').onclick=()=>captureSnapshot('output');
  $('#preview-toggle').onclick=togglePreview;$('#help').onclick=help;
  window.addEventListener('keydown',keyDown);window.addEventListener('keyup',keyUp);
  const releasePointer=e=>{pendingDashboardDrag=null;const held=heldPointers.get(e.pointerId);if(held){releaseHeld(held);heldPointers.delete(e.pointerId);}};
  window.addEventListener('pointerup',releasePointer);window.addEventListener('pointercancel',releasePointer);
  window.addEventListener('blur',()=>{pendingDashboardDrag=null;for(const [key,value] of heldKeys){releaseHeld(value);heldKeys.delete(key);}for(const value of heldPointers.values())releaseHeld(value);heldPointers.clear();});
  window.addEventListener('dragover',e=>e.preventDefault());window.addEventListener('drop',e=>e.preventDefault());
  document.addEventListener('pointerdown',()=>engine.audioContext?.resume().catch(()=>{}));
  // Number fields accept math ("1920/3", "/2") and ↑/↓ nudges, like
  // Resolume's Dingetje (manual p. 132). Runs before the field's own handler.
  const numberField=target=>target instanceof HTMLInputElement&&target.dataset.number!==undefined;
  document.addEventListener('change',event=>{
    if(!numberField(event.target))return;
    const input=event.target,value=evaluateExpression(input.value,Number(input.defaultValue)||0);
    if(Number.isFinite(value))input.value=String(Number(value.toFixed(6)));
  },true);
  document.addEventListener('keydown',event=>{
    if(!numberField(event.target))return;
    const input=event.target;
    if(event.key==='Enter'){event.preventDefault();input.blur();return;}
    if(event.key!=='ArrowUp'&&event.key!=='ArrowDown')return;
    event.preventDefault();
    const step=(Number(input.getAttribute('step'))||0.01)*(event.shiftKey?10:1)*(event.key==='ArrowUp'?1:-1);
    const current=evaluateExpression(input.value,0);
    input.value=String(Number(((Number.isFinite(current)?current:0)+step).toFixed(6)));
    input.dispatchEvent(new Event('change',{bubbles:true}));
  },true);
  // Parameter cogwheels open the animation menu (manual p. 141).
  document.addEventListener('click',event=>{
    const cog=event.target.closest('[data-animate-path]');
    if(!cog||document.documentElement.dataset.shortcutEdit)return;
    event.preventDefault();event.stopPropagation();
    const rect=cog.getBoundingClientRect(),path=cog.dataset.animatePath,panel=cog.closest('[data-inspector-panel]');
    const owner=panel?inspectorTarget(panel.dataset.scope):null;
    const dashboardNames=(owner?.dashboard||[]).map((dial,index)=>dial.key?`Dial ${index+1} (${dial.key})`:`Dial ${index+1}`);
    showMenu({clientX:rect.left,clientY:rect.bottom+2},animationMenuItems(project,path,{dashboardNames,changed:()=>{changed();renderInspector();}}));
  });
  window.addEventListener('beforeunload',()=>{if(dirty)autosave();for(const url of objectURLs)URL.revokeObjectURL(url);});
}

// Shortcut targets: map an interface control to its parameter or action path.
function targetFor(element){
  const el=element.closest('[data-param-path],[data-animate-path],[data-prop],[data-number],[data-layer-prop],[data-action],[data-group-prop],[data-group-action],[data-fx-bypass],[data-clip],[data-column],[data-deck],[data-group-column],button[id],input[id]');
  if(!el)return null;
  if(el.dataset.paramPath)return el.dataset.paramPath;
  if(el.dataset.animatePath)return el.dataset.animatePath;
  const host=el.closest('[data-inspector-panel]');
  if(host&&(el.dataset.prop||el.dataset.number)){const scope=host.dataset.scope,target=inspectorTarget(scope),key=el.dataset.prop||el.dataset.number;return target&&(PROPERTY_PARAMS[scope]||[]).some(param=>param.key===key)?`${ownerPath(scope,target)}/${key}`:null;}
  const row=el.closest('[data-layer]');
  if(row&&el.dataset.layerProp&&el.dataset.layerProp!=='blend')return `layer/${row.dataset.layer}/${el.dataset.layerProp}`;
  if(row&&el.dataset.action)return el.dataset.action==='stop'?`action/layer/${row.dataset.layer}/clear`:`layer/${row.dataset.layer}/${el.dataset.action}`;
  const groupRow=el.closest('[data-group-row]');
  if(groupRow&&el.dataset.groupProp&&el.dataset.groupProp!=='blend')return `group/${groupRow.dataset.groupRow}/${el.dataset.groupProp}`;
  if(groupRow&&el.dataset.groupAction)return el.dataset.groupAction==='clear'?`action/group/${groupRow.dataset.groupRow}/clear`:`group/${groupRow.dataset.groupRow}/${el.dataset.groupAction}`;
  if(el.dataset.fxBypass!==undefined){const card=el.closest('[data-effect]');return card?`${el.closest('[data-effect-stack="audio"]')?'audiofx':'effect'}/${card.dataset.effect}/enabled`:null;}
  if(el.dataset.clip)return `action/clip/${el.dataset.clip}/trigger`;
  if(el.dataset.column!==undefined)return `action/column/${el.dataset.column}`;
  if(el.dataset.deck)return `action/deck/${el.dataset.deck}`;
  if(el.id==='previous-column'||el.id==='next-column')return `action/composition/${el.id==='next-column'?'next':'previous'}-column`;
  return {'master-opacity':'composition/masterOpacity','master-volume':'composition/masterVolume',crossfader:'composition/crossfader','global-speed':'composition/speed',bpm:'composition/bpm',pause:'composition/paused',blackout:'composition/blackout','bypass-all':'composition/bypass',tap:'action/composition/tap','clear-all':'action/composition/clear','cross-a':'action/composition/fade-a','cross-b':'action/composition/fade-b',resync:'action/composition/resync'}[el.id]||null;
}
function runAction(path,pressed,inputId=id()){
  const [,kind,a,b]=path.split('/');
  const release=()=>{const held=shortcutHolds.get(inputId);shortcutHolds.delete(inputId);if(held)releaseHeld(held);};
  if(kind==='clip'){
    const found=findClip(a);if(!found)return;const {clip,layer}=found;
    if(!pressed)return release();
    const held={layerId:layer.id,clipId:clip.id,inputId};shortcutHolds.set(inputId,held);
    trigger(layer,clip,()=>!transport.isPiano(clip)||shortcutHolds.get(inputId)===held,{inputId,selectedLayerId});return;
  }
  if(kind==='column'){if(pressed)beginColumnHold(Number(a),shortcutHolds,inputId);else release();return;}
  if(!pressed)return;
  if(kind==='layer'){const layer=project.layers.find(item=>item.id===a);if(!layer)return;if(b==='clear'){triggerRequests.delete(layer.id);transport.stop(layer.id);}else if(b==='next')stepLayerClip(layer,1);else if(b==='previous')stepLayerClip(layer,-1);renderLayers();}
  else if(kind==='group'&&b==='clear'){for(const layer of project.layers)if(layer.groupId===a){triggerRequests.delete(layer.id);transport.stop(layer.id);}renderLayers();}
  else if(kind==='deck'&&project.decks.some(deck=>deck.id===a)){project.selectedDeckId=a;changed();renderDecks();renderLayers();}
  else if(kind==='composition'){if(a==='tap')$('#tap').click();else if(a==='clear')$('#clear-all').click();else if(a==='fade-a')crossfaderButton('A',true),crossfaderButton('A',false);else if(a==='fade-b')crossfaderButton('B',true),crossfaderButton('B',false);else if(a==='resync')transport.resync(now());else if(a==='next-column')stepColumn(1);else if(a==='previous-column')stepColumn(-1);}
}
// Map a shortcut path onto the selected layer/clip/group (Shortcut Target "Selected").
function retarget(path){
  const parts=path.split('/'),scope=parts[0]==='action'?parts[1]:parts[0],at=parts[0]==='action'?2:1;
  const id=scope==='layer'?selectedLayerId:scope==='clip'?selectedClipId:scope==='group'?currentGroup()?.id:null;
  if(!id)return null;
  parts[at]=id;return parts.join('/');
}
function actionState(path){const [,kind,a]=path.split('/');if(kind==='clip')return project.layers.some(layer=>layer.activeClipId===a);if(kind==='deck')return project.selectedDeckId===a;return false;}
function releaseHeld(held){for(const voice of held.clips||[held])transport.release(voice.layerId,voice.clipId,{inputId:voice.inputId});}
function beginColumnHold(index,holds,key){
  const held={inputId:id(),clips:[]};holds.set(key,held);
  return triggerColumn(index,{inputId:held.inputId,held,stillHeld:()=>holds.get(key)===held});
}
async function trigger(layer,clip,stillHeld=()=>true,options={}){
  const selected=options.selectedLayerId||selectedLayerId,target=clip.clipTarget==='inherit'||!clip.clipTarget?project.clipTarget:clip.clipTarget;
  const request=id(),key=target==='free'?request:target==='selected'?selected:layer.id;
  triggerRequests.set(key,request);
  try{await engine.prepare(clip);if(triggerRequests.get(key)!==request||!findClip(clip.id)||!stillHeld())return;
    engine.audioContext?.resume().catch(()=>{});
    const receipt=transport.triggerRouted(layer.id,clip.id,now(),{...options,selectedLayerId:selected});
    if(!receipt)return toast('No free layer is available for this clip.');
    if(preferences.clipPanelFollowsTrigger){selectedClipId=clip.id;selectedClips.clear();selectedClips.add(clip.id);selectedColumn=slotForClip(clip.id)?.column||0;selectedLayerId=target==='selected'?selected:layer.id;inspectorTab='clip';renderInspector();}
    renderLayers();return receipt;
  }catch(error){toast('Cannot play '+clip.name+': '+error.message,true);}
  finally{if(triggerRequests.get(key)===request)triggerRequests.delete(key);}
}

function stepColumn(step){const count=project.columns||8;triggerColumn(((lastColumn<0?(step>0?-1:count):lastColumn)+step+count)%count);}
async function triggerColumn(index,{inputId,stillHeld=()=>true,held,groupId}={}){if(!groupId)lastColumn=index;const items=project.layers.filter(layer=>groupId?layer.groupId===groupId:!groupOfLayer(layer)?.ignoreColumn).map(layer=>({layer,clip:clipList(layer)[index],request:id()})).filter(item=>item.clip&&!item.layer.ignoreColumn&&!item.clip.ignoreColumn&&!findClip(item.layer.activeClipId)?.clip.ignoreColumn);if(held)held.clips=items.map(item=>({layerId:item.layer.id,clipId:item.clip.id,inputId}));for(const item of items)triggerRequests.set(item.layer.id,item.request);const results=await Promise.allSettled(items.map(item=>engine.prepare(item.clip)));const time=now();for(let i=0;i<items.length;i++){const item=items[i];if(results[i].status==='rejected'){toast(`Cannot play ${item.clip.name}: ${results[i].reason.message}`,true);continue;}if(triggerRequests.get(item.layer.id)===item.request&&findClip(item.clip.id)&&(!transport.isPiano(item.clip)||stillHeld()))transport.trigger(item.layer.id,item.clip.id,time,{target:'own',inputId});}engine.audioContext?.resume().catch(()=>{});renderLayers();return items.map(item=>({layerId:item.layer.id,clipId:item.clip.id,inputId}));}
function addSource(source,layer=currentLayer(),index,extra={}){
  if(layer.locked)return toast(`${layer.name} is locked. Unlock it in the layer panel to change its content.`);
  const deckId=project.selectedDeckId;
  if(index===undefined)index=clipList(layer).findIndex(c=>!c);
  if(index<0)return toast('This layer is full. Add a deck or choose an empty slot.');
  const visible=visibleSlot(project,layer,deckId,index);
  if(visible.persistentFrom&&visible.persistentFrom!==deckId)return toast('This slot is covered by a persistent clip. Choose another slot or turn off persistence.');
  const definition=sourceDefinition(source);
  const clip=source==='effect-clip'?createClip('effect',{name:extra.name||'Effect clip'}):createClip('source',{name:extra.name||definition?.name||source,source,params:extra.params});
  const slots=storedClipList(layer,deckId),previous=slots[index];
  if(previous){if(previous.id===layer.activeClipId)transport.stop(layer.id);engine.remove(previous.id);}
  slots[index]=clip;selectClip(layer,clip,index);changed();renderAll();requestThumbnails();
}
async function importFiles(layer=currentLayer(),index){
  if(desktop){try{const files=await desktop.importMedia();for(const file of files||[]){await placeMedia(file,layer,index);if(index!==undefined)index++;}}catch(e){toast(e.message,true);}return;}
  const input=document.createElement('input');input.type='file';input.accept='video/*,audio/*,image/*';input.multiple=true;input.onchange=()=>importFileList([...input.files],layer,index);input.click();
}
// Image sequences (manual p. 65): a folder of numbered stills plays as a clip.
async function importSequence(layer=currentLayer(),index){
  if(!desktop?.importSequence)return toast('Image sequences need the Windows app.');
  try{const item=await desktop.importSequence();if(item)await placeMedia(item,layer,index);}catch(error){toast(`Image sequence import failed: ${error.message}`,true);}
}
async function importFileList(files,layer,index){for(const file of files){let item;if(desktop?.getPathForFile){const path=desktop.getPathForFile(file);[item]=await desktop.importPaths([path]);}else{const url=URL.createObjectURL(file);objectURLs.add(url);item={name:file.name,url,path:'',kind:file.type.startsWith('audio/')?'audio':file.type.startsWith('image/')?'image':kindFor(file.name)};}await placeMedia(item,layer,index);if(index!==undefined)index++;}}
function kindFor(name){return /\.(png|jpe?g|gif|bmp|webp|avif|svg)$/i.test(name)?'image':/\.(wav|mp3|ogg|flac|m4a|aac|aiff?)$/i.test(name)?'audio':'video';}
async function placeMedia(item,layer,index){
  if(item.error)return toast(`Cannot import ${item.name}: ${item.error}`,true);
  if(layer.locked)return toast(`${layer.name} is locked. Unlock it to change its content.`);
  const destinationProject=project,deckId=project.selectedDeckId;
  if(index===undefined)index=clipList(layer).findIndex(c=>!c);
  if(index<0||index>=(project.columns||8))return toast('This layer is full. Add another deck for more media.');
  if(visibleSlot(project,layer,deckId,index).persistentFrom&&visibleSlot(project,layer,deckId,index).persistentFrom!==deckId)return toast('This slot is covered by a persistent clip. Choose another slot or turn off persistence.');
  const clip=createClip(item.kind||kindFor(item.name),item);
  try{
    const media=await engine.prepare(clip);
    if(project!==destinationProject||!project.decks.some(deck=>deck.id===deckId)||!project.layers.includes(layer))throw new Error('The destination deck changed during import.');
    const shown=visibleSlot(project,layer,deckId,index);
    if(shown.persistentFrom&&shown.persistentFrom!==deckId)throw new Error('The destination is covered by a persistent clip.');
    if(!clip.audio&&media&&Number.isFinite(media.duration))clip.duration=media.duration;
    const slots=storedClipList(layer,deckId),previous=slots[index];
    if(previous){if(layer.activeClipId===previous.id)transport.stop(layer.id);engine.remove(previous.id);}
    slots[index]=clip;
    if(!mediaLibrary.some(m=>m.path===item.path&&m.url===item.url))mediaLibrary.push(item);
    if(project.selectedDeckId===deckId)selectClip(layer,clip,index);
    changed();renderAll();requestThumbnails();toast(`Imported ${clip.name}`);return clip;
  }catch(e){engine.remove(clip.id);toast(`Cannot import ${item.name}: ${e.message}`,true);return null;}
}

async function itemFromFile(file){
  if(desktop?.getPathForFile){const [item]=await desktop.importPaths([desktop.getPathForFile(file)]);return item;}
  const url=URL.createObjectURL(file);objectURLs.add(url);
  return {name:file.name,url,path:'',kind:file.type.startsWith('audio/')?'audio':file.type.startsWith('image/')?'image':kindFor(file.name)};
}
async function chooseMedia(kind){
  try{
    if(desktop){const items=await desktop.importMedia();const item=items?.[0];if(!item)return null;if(item.error)throw new Error(item.error);if(item.kind!==kind)throw new Error(`Choose an ${kind} file.`);return item;}
    return await new Promise(resolve=>{
      const input=document.createElement('input');input.type='file';input.accept=kind+'/*';
      input.oncancel=()=>resolve(null);
      input.onchange=async()=>{try{const file=input.files[0];if(!file)return resolve(null);const item=await itemFromFile(file);if(item.kind!==kind)throw new Error(`Choose an ${kind} file.`);resolve(item);}catch(error){toast(error.message,true);resolve(null);}};
      input.click();
    });
  }catch(error){toast(error.message,true);return null;}
}
async function pairAudio(clip,item){
  if(item.error)return toast(item.error,true);
  if(item.kind!=='audio')return toast('Choose an audio file to pair with this clip.',true);
  if(clip.kind==='audio')return toast('Pair audio with a video, image, or generated source.',true);
  const probe=createClip('audio',item),old={audio:clip.audio,duration:clip.duration,videoDuration:clip.videoDuration,useAudio:clip.useAudio};
  try{
    await engine.prepare(probe);engine.remove(probe.id);
    if(!findClip(clip.id))return;
    clip.videoDuration=clip.videoDuration||clip.duration;
    clip.audio={id:probe.id,path:item.path||'',url:item.url,duration:probe.duration};clip.duration=probe.duration;clip.useAudio=true;
    await engine.prepare(clip);if(old.audio)engine.remove(old.audio.id);
    changed();renderInspector();toast(`Paired ${item.name} with ${clip.name}`);
  }catch(error){Object.assign(clip,old);engine.remove(probe.id);toast(`Pairing failed: ${error.message}`,true);}
}
async function reconnectComponent(clip,component){
  try{
    if(desktop?.reconnectMedia){const result=await desktop.reconnectMedia(serializeProject(project),{clipId:clip.id,component});if(result)applyReconnected(result);}
    else if(component==='audio'){const item=await chooseMedia('audio');if(item)await pairAudio(clip,item);}
    else await relinkClip(clip);
  }catch(error){toast(`Reconnect failed: ${error.message}`,true);}
}
async function relinkAll(){
  if(!desktop?.relinkProject)return toast('Reconnect folders in the Windows app.');
  try{const result=await desktop.relinkProject(serializeProject(project));if(result)applyReconnected(result);}catch(error){toast(`Reconnect failed: ${error.message}`,true);}
}
function applyReconnected(result){
  const incoming=validateProject(result.project),sources=new Map();if(incoming.id!==project.id)return;
  const remember=value=>{if(value?.id)sources.set(value.id,value);};
  remember(incoming.mask);
  for(const layer of incoming.layers){remember(layer.mask);for(const clip of Object.values(layer.clips).flat())if(clip){remember(clip);remember(clip.audio);remember(clip.mask);}}
  const update=value=>{const next=value&&sources.get(value.id);if(!next)return false;const changed=value.path!==next.path||value.url!==next.url;value.path=next.path;value.url=next.url;return changed;};
  if(update(project.mask))engine.removeMask?.(project.mask.id);
  for(const layer of project.layers){if(update(layer.mask))engine.removeMask?.(layer.mask.id);for(const clip of Object.values(layer.clips).flat())if(clip){const primary=update(clip),audio=update(clip.audio),mask=update(clip.mask);if(primary)engine.remove(clip.id);else if(audio)engine.remove(clip.audio.id);if(mask)engine.removeMask?.(clip.mask.id);}}
  changed();renderAll();
  const count=result.relinked?.length||0,remaining=result.missing?.length||0;
  toast(`Reconnected ${count} media reference${count===1?'':'s'}. ${remaining} still missing.${result.ambiguous?.length?' Some names match multiple files; reconnect those individually.':''}${result.scan?.truncated||result.scan?.errors?.length?' The search was incomplete; choose a smaller folder with readable files.':''}`,remaining>0);
}

async function relinkClip(clip){
  async function replace(item){
    if(item.error)throw new Error(item.error);
    const replacement={...clip,path:item.path||'',url:item.url,kind:item.kind||kindFor(item.name)};
    engine.remove(clip.id);
    try{const media=await engine.prepare(replacement);if(!replacement.audio&&media&&Number.isFinite(media.duration))replacement.duration=media.duration;Object.assign(clip,replacement);changed();renderAll();toast(`Reconnected ${clip.name}`);}
    catch(e){engine.remove(clip.id);throw e;}
  }
  try{
    if(desktop){const items=await desktop.importMedia();if(items?.[0])await replace(items[0]);}
    else{const input=document.createElement('input');input.type='file';input.accept='video/*,audio/*,image/*';input.onchange=async()=>{const file=input.files[0];if(!file)return;const url=URL.createObjectURL(file);objectURLs.add(url);try{await replace({name:file.name,url,kind:kindFor(file.name)});}catch(e){toast(e.message,true);}};input.click();}
  }catch(e){toast(`Reconnect failed: ${e.message}`,true);}
}

async function saveProject(saveAs=false){try{const data=serializeProject(project);if(desktop){const result=await desktop.saveProject(data,saveAs);if(!result)return;}else download(new Blob([JSON.stringify(data,null,2)],{type:'application/json'}),project.name+'.prism.json');dirty=false;$('#save-state').textContent='SAVED';toast('Composition saved.');}catch(e){toast(`Save failed: ${e.message}`,true);}}
async function openProject(){try{if(desktop){const result=await desktop.openProject();if(result){loadProject(result.project);if(result.missing?.length)toast(`${result.missing.length} media file(s) are missing. Select each affected clip and use Reconnect media.`,true);}}else{const input=document.createElement('input');input.type='file';input.accept='.json,.prism';input.onchange=async()=>{try{loadProject(JSON.parse(await input.files[0].text()));}catch(e){toast(`Open failed: ${e.message}`,true);}};input.click();}}catch(e){toast(`Open failed: ${e.message}`,true);}}
function loadProject(data){
  const valid=validateProject(data);clearTimeout(saveTimer);triggerRequests.clear();selectedClips.clear();selectedColumn=0;
  if(preview)stopPreview();if(recorder?.state==='recording')recorder.stop();
  for(const owner of [project,...project.layers])if(owner.mask)engine.removeMask(owner.mask.id);
  for(const layer of project.layers)for(const clip of Object.values(layer.clips).flat())if(clip)engine.remove(clip.id);
  project=valid;transport=new Transport(project);selectedLayerId=project.layers.at(-1).id;selectedClipId=null;undoStack=[];redoStack=[];lastHistory=snapshot();dirty=false;
  engine.resize(project.width,project.height);transport.tick(now());prewarmCatalog();requestThumbnails();
  for(const clipId of new Set(project.layers.map(layer=>layer.activeClipId).filter(Boolean))){const clip=findClip(clipId)?.clip;if(clip)engine.prepare(clip).catch(error=>toast(error.message,true));}
  renderAll();$('#save-state').textContent='LOADED';toast(`Loaded ${project.name}`);
}
async function recoverAvailable(){try{const recovered=desktop?await desktop.recoverProject():JSON.parse(localStorage.getItem('prism-recovery')||'null');if(!recovered)return;const yes=await confirmDialog('Recover your last session?',`A recovery copy of “${recovered.name||'Untitled'}” is available.`,'Recover');if(yes)loadProject(recovered);}catch(e){toast(`Recovery unavailable: ${e.message}`,true);}}
function download(blob,name){const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}

let recordingPending=false;
let snapshotPending=false;
async function captureSnapshot(kind){
  if(snapshotPending)return;
  snapshotPending=true;
  const buttons=['#snapshot-output','#snapshot-clip'].map(selector=>$(selector)).filter(Boolean);
  for(const button of buttons)button.disabled=true;
  const capturedProject=project;
  try{
    let capturedEngine=engine,name=project.name;
    if(kind==='clip'){
      const clip=currentClip();
      if(!clip||clip.kind==='audio'||clip.useVideo===false)throw new Error('Select a clip with video before taking its snapshot.');
      name=clip.name;
      if(!preview||preview.clip.id!==clip.id)startPreview(clip);
      const currentPreview=preview;
      await currentPreview.ready;
      if(preview!==currentPreview||project!==capturedProject)throw new Error('The selected clip changed before its frame was ready.');
      const time=now();currentPreview.project.width=project.width;currentPreview.project.height=project.height;currentPreview.project.bpm=project.bpm;
      const frames=currentPreview.transport.tick(time).map(frame=>({...frame,clip:{...frame.clip,opacity:1,volume:0}}));
      currentPreview.engine.render(currentPreview.project,frames,time);
      if(currentPreview.engine.flushPrograms())currentPreview.engine.render(currentPreview.project,frames,time);
      capturedEngine=currentPreview.engine;
    }else if(kind==='output'){
      const time=now(),frames=transport.tick(time);engine.render(project,frames,time,{beat:transport.beat});
      if(engine.flushPrograms())engine.render(project,frames,time,{beat:transport.beat});
    }else throw new Error('Unknown snapshot type.');
    const blob=await capturedEngine.capturePNG({transparent:kind==='clip'});
    const filename=`Prism-${kind}-${new Date().toISOString().replace(/[:.]/g,'-')}.png`;
    const path=desktop?.saveSnapshot?await desktop.saveSnapshot(kind,name,await blob.arrayBuffer()):null;
    if(!desktop)download(blob,filename);
    if(project!==capturedProject){toast(`Snapshot saved${path?`: ${path}`:''}. The composition changed before it could be imported.`);return;}
    const bottom=project.layers[0];
    if(!clipList(bottom).some(clip=>!clip)){toast(`Snapshot saved${path?`: ${path}`:''}. Add an empty slot to the bottom layer to import it.`);return;}
    let item;
    if(path){[item]=await desktop.importPaths([path]);if(!item||item.error)throw new Error(item?.error||'Could not import the saved PNG.');}
    else {const url=URL.createObjectURL(blob);objectURLs.add(url);item={name:filename,kind:'image',url,path:''};}
    const imported=await placeMedia(item,bottom);
    if(imported)toast(`Snapshot saved and added${path?`: ${path}`:''}`);
  }catch(error){toast(`Snapshot failed: ${error.message}`,true);}
  finally{snapshotPending=false;for(const button of buttons)if(button.isConnected)button.disabled=false;}
}
async function toggleRecording(){
  if(recordingPending)return;
  if(recorder?.state==='recording'){recorder.stop();return;}
  recordingPending=true;
  let stream, session=null;
  try{
    await engine.audioContext?.resume();
    stream=engine.recordingStream();
    const mime=['video/webm;codecs=vp9,opus','video/webm;codecs=vp8,opus','video/webm'].find(t=>MediaRecorder.isTypeSupported(t));
    if(!mime)throw new Error('This system has no supported WebM recorder.');
    const next=new MediaRecorder(stream,{mimeType:mime,videoBitsPerSecond:12000000});
    if(desktop?.beginRecording){session=await desktop.beginRecording();if(!session){stream.getVideoTracks().forEach(t=>t.stop());return;}}
    recorder=next;recordChunks=[];
    const recordedProjectId=project.id;let bytes=0,pendingBytes=0,writeQueue=Promise.resolve(),recordingError=null;
    const fail=error=>{if(recordingError)return;recordingError=error;toast(`Recording stopped: ${error.message}`,true);if(next.state==='recording')next.stop();};
    next.ondataavailable=e=>{
      if(!e.data.size||recordingError)return;
      if(session){
        pendingBytes+=e.data.size;
        if(pendingBytes>64*1024*1024){fail(new Error('The disk could not keep up. Accepted recording data will be saved.'));return;}
        writeQueue=writeQueue.then(async()=>{const buffer=await e.data.arrayBuffer();await desktop.writeRecordingChunk(session.id,buffer);}).catch(fail).finally(()=>{pendingBytes-=e.data.size;});
      }else{
        recordChunks.push(e.data);bytes+=e.data.size;
        if(bytes>256*1024*1024&&next.state==='recording'){next.stop();toast('Recording reached 256 MB and has been stopped for saving.');}
      }
    };
    next.onerror=e=>fail(e.error||new Error('Recorder failed.'));
    next.onstop=async()=>{
      recordingPending=true;$('#record').disabled=true;$('#record').textContent='Saving…';
      try{
        let path;
        if(session){await writeQueue;path=await desktop.finishRecording(session.id);}
        else{const blob=new Blob(recordChunks,{type:mime});recordChunks=[];if(desktop)path=await desktop.saveRecording(await blob.arrayBuffer());else download(blob,`Prism-${new Date().toISOString().replace(/[:.]/g,'-')}.webm`);}
        if(path){toast(`Recording saved: ${path}`);const bottom=project.layers[0];if(project.id===recordedProjectId&&clipList(bottom).some(c=>!c)){const [item]=await desktop.importPaths([path]);await placeMedia(item,bottom);}}
      }catch(e){toast(`Recording could not be finalized: ${e.message}`,true);}
      finally{stream.getVideoTracks().forEach(t=>t.stop());recordingPending=false;$('#record').disabled=false;$('#record').classList.remove('active');$('#record').textContent='● Record';}
    };
    next.start(1000);recordingStarted=now();$('#record').classList.add('active');toast('Recording composition video and mixed audio.');
  }catch(e){stream?.getVideoTracks().forEach(t=>t.stop());if(session)await desktop.finishRecording(session.id).catch(()=>{});toast(`Recording could not start: ${e.message}`,true);}
  finally{recordingPending=false;}
}

async function openOutput(){
  if(outputs.active||outputOpen){outputs.closeAll();if(desktop?.closeOutput)await desktop.closeOutput().catch(()=>{});outputOpen=false;$('#output').classList.remove('active');toast('Outputs closed.');return;}
  displaysCache=desktop?await desktop.getDisplays():[];
  const configured=project.advancedOutput?.screens?.some(screen=>screen.enabled!==false&&screen.device?.type==='display');
  const body=`<p>Send the composition to a display. Escape in an output window leaves fullscreen.</p>${displaysCache.length?`<div class="select-field"><label>Display</label><select id="display-choice">${displaysCache.map(d=>`<option value="${d.id}">${esc(d.label)} · ${d.width} × ${d.height}</option>`).join('')}</select></div>`:'<p class="browser-note">In the browser, the output opens in a new window you can drag to another display.</p>'}${configured?'<p class="browser-note">This composition has an Advanced Output setup. “Open Advanced Output screens” uses its screens and slices.</p>':''}`;
  const dialog=showDialog('Output',body,[['Cancel','cancel'],['Advanced Output…','advanced'],...(configured?[['Open Advanced Output screens','configured']]:[]),['Open output','open']]);
  dialog.addEventListener('close',async()=>{
    const action=dialog.returnValue;
    if(action==='advanced')return openOutputEditor();
    if(action!=='open'&&action!=='configured')return;
    let config=project.advancedOutput;
    if(action==='open'){
      // A quick output is a single full-composition screen on the chosen display.
      const screen=screenFromComposition(project.width,project.height);
      const display=displaysCache.find(item=>String(item.id)===String($('#display-choice',dialog)?.value));
      config={version:1,screens:[{...screen,name:display?.label||'Output',device:display?{type:'display',displayId:String(display.id),width:project.width,height:project.height}:{...screen.device}}]};
    }
    const opened=outputs.sync(config,{displays:displaysCache});
    if(!opened&&desktop?.openOutput){await desktop.openOutput(Number($('#display-choice',dialog)?.value));toast('Using the compatibility output window.');}
    outputOpen=opened>0||!!desktop?.openOutput;$('#output').classList.toggle('active',outputOpen);
  });
}
async function openOutputEditor(){
  if(outputEditor)return;
  const {openAdvancedOutput}=await import('./output/editor.js');
  if(outputEditor)return;
  const host=document.createElement('div');host.className='output-overlay';document.body.append(host);
  const config=project.advancedOutput||normalizeOutputConfig(null,{compositionWidth:project.width,compositionHeight:project.height});
  const done=()=>{outputEditor?.close?.();outputEditor=null;host.remove();};
  outputEditor=openAdvancedOutput({host,config,compositionCanvas:$('#output-canvas'),compositionSize:{width:project.width,height:project.height},
    displays:displaysCache.map(item=>({id:String(item.id),label:item.label,width:item.width,height:item.height})),
    layers:project.layers.map(layer=>({id:layer.id,name:layer.name})),groups:(project.groups||[]).map(group=>({id:group.id,name:group.name})),
    outputOptions:outputs.options,onOutputOptions:options=>outputs.setOptions(options),
    onChange:next=>{project.advancedOutput=next;changed();if(outputs.active)outputs.sync(next,{displays:displaysCache});else engine.setReadbacks(routedSources(next).map(source=>source.replace(/^(layer|group):/,'')));},
    onClose:()=>{if(!outputs.active)engine.setReadbacks([]);done();}});
  engine.setReadbacks(routedSources(config).map(source=>source.replace(/^(layer|group):/,'')));
  const escape=event=>{if(event.key==='Escape'&&!event.defaultPrevented&&outputEditor&&!$('dialog[open]')){document.removeEventListener('keydown',escape);done();}};
  document.addEventListener('keydown',escape);
}
// DMX output (manual pp. 125–131): sample fixture areas of the visible output.
function controlExtrasHTML(){
  const dmx=project.dmx||normalizeDmxConfig(null),lumiverse=id=>dmx.lumiverses.find(item=>item.id===id);
  const fixture=item=>`<div class="dmx-fixture" data-fixture="${esc(item.id)}"><div class="row"><input data-fixture-field="name" value="${esc(item.name)}" aria-label="Fixture name" class="grow"><button data-fixture-remove title="Remove fixture">×</button></div>
    <div class="dmx-grid">${[['universe','Universe',lumiverse(item.lumiverseId)?.universe??0],['startChannel','Start ch',item.startChannel],['x','X',item.rect.x],['y','Y',item.rect.y],['width','W',item.rect.width],['height','H',item.rect.height],['columns','Cols',item.columns],['rows','Rows',item.rows]].map(([key,label,value])=>`<label>${label}<input type="number" data-fixture-field="${key}" value="${value}"></label>`).join('')}
    <label>Channels<select data-fixture-field="channels">${['rgb','grb','bgr','rgbw','rgba','w','dimmer-rgb'].map(value=>`<option ${item.channels===value?'selected':''}>${value}</option>`).join('')}</select></label><label>Order<select data-fixture-field="order">${['row-major','snake','column-major','column-snake'].map(value=>`<option ${item.order===value?'selected':''}>${value}</option>`).join('')}</select></label></div></div>`;
  return `${desktop?.sendOSC?`<div class="section"><h3>OSC output</h3><div class="row"><label><input id="osc-out-enabled" type="checkbox" ${preferences.oscOutEnabled?'checked':''}> Send feedback</label><input id="osc-out-host" value="${esc(preferences.oscOutHost)}" style="width:110px" aria-label="OSC output host"><input id="osc-out-port" type="number" min="1" max="65535" value="${preferences.oscOutPort}" style="width:70px" aria-label="OSC output port"></div><p class="browser-note">OSC shortcuts with feedback send their current value (0–1) to this address.</p></div>`:''}
    <div class="section"><h3>DMX output (Art-Net / sACN)</h3><div class="row wrap"><label><input id="dmx-enabled" type="checkbox" ${dmx.enabled&&dmxActive?'checked':''}> Send DMX</label><select id="dmx-protocol" aria-label="DMX protocol">${['artnet','sacn'].map(value=>`<option value="${value}" ${dmx.protocol===value?'selected':''}>${value==='artnet'?'Art-Net':'sACN'}</option>`).join('')}</select><input id="dmx-host" value="${esc(dmx.host)}" placeholder="${dmx.protocol==='sacn'?'multicast':'255.255.255.255'}" style="width:120px" aria-label="DMX destination"></div>
    <p class="browser-note">Fixtures sample a rectangle of the output (composition pixels) as a grid of RGB pixels.</p>${dmx.fixtures.map(fixture).join('')}<button id="dmx-add-fixture" class="icon-btn">+ Fixture</button>
    <h3 style="margin-top:10px">DMX input (shortcuts)</h3><div class="row"><label><input id="dmx-input-enabled" type="checkbox" ${dmx.input.enabled?'checked':''}> Receive</label><input id="dmx-input-universe" type="number" min="0" max="32767" value="${dmx.input.universe}" style="width:70px" aria-label="DMX input universe"></div></div>`;
}
function bindControlExtras(){
  const host=$('#browser'),save=next=>{project.dmx=normalizeDmxConfig(next);changed();};
  const savePreferences=()=>{preferences=writePreferences({...preferences,oscOutEnabled:$('#osc-out-enabled')?.checked??preferences.oscOutEnabled,oscOutHost:$('#osc-out-host')?.value??preferences.oscOutHost,oscOutPort:Number($('#osc-out-port')?.value)||preferences.oscOutPort});oscSent.clear();};
  for(const selector of ['#osc-out-enabled','#osc-out-host','#osc-out-port'])$(selector)?.addEventListener('change',savePreferences);
  $('#dmx-enabled')?.addEventListener('change',event=>setDmxOutput(event.target.checked));
  $('#dmx-protocol')?.addEventListener('change',event=>{save({...(project.dmx||{}),protocol:event.target.value,port:undefined,host:undefined});if(dmxActive)setDmxOutput(true);else renderBrowser();});
  $('#dmx-host')?.addEventListener('change',event=>{save({...(project.dmx||{}),host:event.target.value.trim()});if(dmxActive)setDmxOutput(true);});
  $('#dmx-add-fixture')?.addEventListener('click',()=>{
    const dmx=project.dmx||normalizeDmxConfig(null),lumiverses=dmx.lumiverses.length?dmx.lumiverses:[{id:'lumiverse-1',name:'Lumiverse 1',universe:dmx.protocol==='sacn'?1:0}];
    save({...dmx,lumiverses,fixtures:[...dmx.fixtures,{id:`fixture-${crypto.randomUUID()}`,name:`Fixture ${dmx.fixtures.length+1}`,lumiverseId:lumiverses[0].id,startChannel:1,rect:{x:0,y:0,width:project.width,height:project.height},columns:8,rows:1,channels:'rgb',order:'row-major'}]});
    renderBrowser();
  });
  for(const card of $$('[data-fixture]',host)){
    const update=(key,value)=>{
      const dmx=project.dmx,fixtures=dmx.fixtures.map(item=>{
        if(item.id!==card.dataset.fixture)return item;
        if(['x','y','width','height'].includes(key))return {...item,rect:{...item.rect,[key]:Number(value)}};
        if(key==='universe'){return {...item,lumiverseId:ensureLumiverse(Number(value))};}
        return {...item,[key]:['startChannel','columns','rows'].includes(key)?Number(value):value};
      });
      save({...project.dmx,fixtures});
    };
    for(const input of $$('[data-fixture-field]',card))input.onchange=()=>update(input.dataset.fixtureField,input.value);
    $('[data-fixture-remove]',card).onclick=()=>{save({...project.dmx,fixtures:project.dmx.fixtures.filter(item=>item.id!==card.dataset.fixture)});renderBrowser();};
  }
  const inputChange=async()=>{
    const enabled=$('#dmx-input-enabled').checked,universe=Number($('#dmx-input-universe').value)||0;
    save({...(project.dmx||{}),input:{...(project.dmx?.input||{}),enabled,universe}});
    try{if(enabled)await desktop?.startDMXInput?.({protocol:project.dmx.protocol,universes:[universe]});else await desktop?.stopDMXInput?.();}catch(error){toast(`DMX input: ${error.message}`,true);}
  };
  $('#dmx-input-enabled')?.addEventListener('change',inputChange);$('#dmx-input-universe')?.addEventListener('change',inputChange);
}
function ensureLumiverse(universe){
  const dmx=project.dmx,existing=dmx.lumiverses.find(item=>item.universe===universe);
  if(existing)return existing.id;
  const lumiverse={id:`lumiverse-${crypto.randomUUID()}`,name:`Universe ${universe}`,universe};
  project.dmx={...dmx,lumiverses:[...dmx.lumiverses,lumiverse]};
  return lumiverse.id;
}
function sendDmxFrame(){
  const config=project.dmx,region=fixtureSampleRect(config,{width:project.width,height:project.height});
  if(!region)return;
  const pixels=engine.readRegion(region.x,region.y,region.width,region.height);
  if(!pixels)return;
  const universes=sampleFixtures(pixels,region.width,region.height,config,{flipY:true,region});
  desktop.sendDMX([...universes].map(([universe,data])=>[universe,Uint8Array.from(data)]));
}
async function setDmxOutput(enabled){
  if(!desktop?.startDMX)return toast('DMX output needs the Windows app.',true);
  try{
    project.dmx=normalizeDmxConfig({...(project.dmx||{}),enabled});
    if(enabled){await desktop.startDMX({protocol:project.dmx.protocol,host:project.dmx.host||undefined,port:project.dmx.port,rate:project.dmx.rate});dmxActive=true;}
    else{dmxActive=false;await desktop.stopDMX();}
    changed();renderBrowser();
  }catch(error){dmxActive=false;toast(`DMX output: ${error.message}`,true);}
}
// OSC output: mirror OSC shortcut values back to the sender's controller.
function sendOSCFeedback(){
  const messages=[];
  for(const shortcut of project.shortcuts||[]){
    if(shortcut.source!=='osc'||!shortcut.feedback||!shortcut.input.address)continue;
    const target=shortcut.target.startsWith('action/')?null:resolvePath(project,shortcut.target);
    const value=target?(()=>{const raw=readOwner(target.scope,target.owner,target.key);return typeof raw==='boolean'?(raw?1:0):typeof raw==='number'?Math.round(((raw-(target.param.min??0))/(((target.param.max??1)-(target.param.min??0))||1))*1000)/1000:null;})():actionState(shortcut.target)?1:0;
    if(value===null||oscSent.get(shortcut.id)===value)continue;
    oscSent.set(shortcut.id,value);messages.push({address:shortcut.input.address,args:[value]});
  }
  if(messages.length)desktop.sendOSC(preferences.oscOutHost,preferences.oscOutPort,messages.slice(0,256)).catch(error=>toast(`OSC output: ${error.message}`,true));
}

function stopPreview(){
  if(!preview)return;
  preview.engine.dispose();preview.canvas.remove();preview=null;$('#preview-label').textContent='Preview · No clip selected';$('#preview-wrap').classList.remove('has-preview');$('#preview-toggle').classList.remove('active');
}
function startPreview(clip){
  stopPreview();
  const canvas=document.createElement('canvas');canvas.id='preview-canvas';$('#preview-wrap').append(canvas);$('#preview-wrap').classList.add('has-preview');
  const previewEngine=new LiveEngine(canvas,{onError:message=>toast(message,true)});
  const layer={...createLayer('Preview'),clips:{preview:[clip]},activeClipId:clip.id};
  const previewProject={...project,masterOpacity:1,masterVolume:0,av:1,mask:null,renderOrder:['effects','mask','transform'],pan:0,scale:1,x:0,y:0,rotation:0,rotationX:0,rotationY:0,anchorX:0,anchorY:0,anchorZ:0,blackout:false,bypass:false,paused:false,speed:1,quantize:0,decks:[{id:'preview',name:'Preview'}],selectedDeckId:'preview',layers:[layer],effects:[]};
  preview={canvas,engine:previewEngine,clip,project:previewProject,transport:new Transport(previewProject),ready:previewEngine.prepare(clip)};
  preview.ready.catch(error=>toast(error.message,true));$('#preview-label').textContent='Preview · '+clip.name;$('#preview-toggle').classList.add('active');
}
// Double-clicking an effect previews it over the live composition.
function previewEffect(data){
  const definition=effectDefinition(data.type);
  if(!definition)return;
  if(!sourceDefinition('composition-feed'))registerSource(compositionFeed($('#output-canvas')));
  const effect={id:id(),type:data.type,enabled:true,opacity:1,blend:'normal',params:defaultParams(definition),animations:{}};
  const preset=data.preset!==undefined?readPresets()[data.type]?.[data.preset]:null;
  if(preset)applyPreset(effect,preset);
  startPreview(createClip('source',{name:`${definition.name} on composition`,source:'composition-feed',effects:[effect]}));
  $('#preview-label').textContent=`Preview · ${definition.name} over the composition (drag it onto a panel to use it)`;
}
function togglePreview(){
  if(preview)return stopPreview();const clip=currentClip();if(!clip)return toast('Select a clip to preview.');startPreview(clip);
}

function frame(timestamp){
  const t=timestamp/1000;
  try{const frames=transport.tick(t);const dt=lastFrameTime?Math.min(1,Math.max(0,t-lastFrameTime)):0;lastFrameTime=t;
    animatedCount=applyAnimations(project,frames,animator,{dt:project.paused?0:dt,beat:transport.beat,spectrum:(source,owner)=>engine.spectrum(source,owner)});
    if(timecode)followTimecode(frames);
    engine.render(project,frames,t,{beat:transport.beat});
    if(animatedCount&&t-lastAnimationRefresh>1/30){lastAnimationRefresh=t;refreshControls();}
    for(const host of inspectorHosts)if(host.animationStrips?.length)updateAnimationStrips(host,animationContext);
    if(shortcuts&&t-lastFeedback>.05){lastFeedback=t;shortcuts.syncFeedback();}
    outputs?.present(t);
    if(outputEditor&&t-(outputEditor.lastUpdate||0)>1/30){outputEditor.lastUpdate=t;outputEditor.update?.($('#output-canvas'),new Map(routedSources(project.advancedOutput).map(source=>[source,engine.readback(source.replace(/^(layer|group):/,''))]).filter(([,frame])=>frame)));}
    if(dmxActive&&project.dmx?.enabled&&t-lastDmx>1/Math.max(1,project.dmx.rate||44)){lastDmx=t;sendDmxFrame();}
    if(preferences.oscOutEnabled&&desktop?.sendOSC&&t-lastOscOut>.05){lastOscOut=t;sendOSCFeedback();}if(preview){preview.project.bpm=project.bpm;preview.project.width=project.width;preview.project.height=project.height;preview.engine.render(preview.project,preview.transport.tick(t).map(f=>({...f,clip:{...f.clip,opacity:1,volume:0}})),t);}
    const active=project.layers.map(l=>l.activeClipId).join(',');if(active!==lastActive)renderLayers();
    for(const f of frames){
      const layerTimeline=layerPlayheads.get(f.layer.id);
      if(layerTimeline&&document.activeElement!==layerTimeline)layerTimeline.value=f.position;
      const progress=clipPlayheads.get(f.clip.id);
      if(progress)progress.style.transform=`scaleX(${Math.max(0,Math.min(1,f.position))})`;
      if(f.clip.id===selectedClipId&&f.layer.activeClipId===f.clip.id){
        if(inspectorPlayhead&&document.activeElement!==inspectorPlayhead)inspectorPlayhead.value=f.position;
        if(inspectorTime)inspectorTime.textContent=showRemaining?`-${formatTime(Math.max(0,(f.clip.outPoint-f.position)*f.clip.duration))}`:formatTime(f.time);
      }
    }
    paintFrames++;if(t-lastPaint>.1){lastPaint=t;if(timecode)updateTimecodeStatus();for(const layer of project.layers){const queued=transport.getState(layer.id)?.pendingClipId;for(const slot of queuedSlots.get(layer.id)||[])slot.classList.toggle('queued',slot.dataset.clip===queued);}const beat=transport.beat??t*project.bpm/60;$('#beat-status').textContent=`BEAT ${Math.floor(beat/4)%999+1}.${Math.floor(beat%4)+1}`;if(recorder?.state==='recording')$('#record').textContent='■ '+formatTime(t-recordingStarted);}
    if(t-paintStart>1){$('#frame-count').textContent=`${Math.round(paintFrames/(t-paintStart))} FPS`;paintFrames=0;paintStart=t;const stats=engine.getStats?.();if(stats?.audioRms!==undefined)$('#audio-meter').textContent=stats.audioRms>0?Math.round(20*Math.log10(stats.audioRms))+' dB':'silent';$('#memory-status').textContent=stats?.mediaCount!==undefined?`${stats.mediaCount} media loaded`:'';}
    if(outputOpen&&!outputs?.active&&!sendingFrame&&t-lastOutputFrame>1/30){sendingFrame=true;lastOutputFrame=t;$('#output-canvas').toBlob(async blob=>{try{if(blob)await desktop.sendOutputFrame(await blob.arrayBuffer());}finally{sendingFrame=false;}},'image/jpeg',.9);}
  }catch(e){if(!frame.lastError||t-frame.lastError>5){frame.lastError=t;toast(`Render error: ${e.message}`,true);}}
  requestAnimationFrame(frame);
}
function formatTime(seconds){return `${String(Math.floor(seconds/60)).padStart(2,'0')}:${(seconds%60).toFixed(2).padStart(5,'0')}`;}
let fadeToken=0,crossReturn=null,crossHeld=null;
function setCrossfader(value){fadeToken++;project.crossfader=value;$('#crossfader').value=value;changed('coalesce');}
function fadeCrossfader(to,seconds=2){const token=++fadeToken,start=now(),from=project.crossfader;function step(){if(token!==fadeToken)return;const a=Math.min(1,(now()-start)/seconds);project.crossfader=from+(to-from)*a;$('#crossfader').value=project.crossfader;if(a<1)requestAnimationFrame(step);else changed();}step();}
// A/B buttons follow the composition's Crossfader Behaviour (manual p. 49).
function crossfaderButton(side,down){
  const target=side==='A'?0:1,mode=project.crossfaderBehaviour||'fade';
  if(!down){if(mode==='cut'&&crossHeld===side&&crossReturn!==null){setCrossfader(crossReturn);crossReturn=null;}crossHeld=null;return;}
  if(crossHeld===side)return;
  crossHeld=side;
  if(mode==='fade')fadeCrossfader(target,4*60/Math.max(20,project.bpm||120));
  else if(mode==='jump')setCrossfader(target);
  else if(mode==='jump-return'){if(Math.abs(project.crossfader-target)<1e-6&&crossReturn!==null){setCrossfader(crossReturn);crossReturn=null;}else{crossReturn=project.crossfader;setCrossfader(target);}}
  else{crossReturn=project.crossfader;setCrossfader(target);}
}

function keyDown(e){
  if(e.ctrlKey&&e.shiftKey&&(e.code==='KeyK'||e.code==='KeyM')&&!$('dialog[open]')){
    e.preventDefault();const source=e.code==='KeyK'?'key':'midi';
    if(shortcuts.editing===source)shortcuts.exit();else{if(source==='midi')shortcuts.enableMidi().catch(error=>toast(`MIDI unavailable: ${error.message}`,true));shortcuts.exit();shortcuts.enter(source);}
    browserTab='controls';renderBrowser();return;
  }
  if(shortcuts.editing==='key'&&!$('dialog[open]')&&shortcuts.handleKey(e,true))return;
  if(/INPUT|SELECT|TEXTAREA/.test(e.target.tagName)||$('dialog[open]'))return;
  if((e.ctrlKey||e.metaKey)&&e.code==='Slash'){e.preventDefault();browserTab='effects';renderBrowser();$('#effect-search')?.focus();return;}
  if(shortcuts.handleKey(e,true)){e.preventDefault();return;}
  if(e.ctrlKey||e.metaKey){if(['c','x','v'].includes(e.key.toLowerCase())){e.preventDefault();if(e.key.toLowerCase()==='v')pasteSelection();else copySelection(e.key.toLowerCase()==='x');return;}if(['s','o','z','y'].includes(e.key.toLowerCase())){e.preventDefault();if(e.key.toLowerCase()==='s')saveProject(e.shiftKey);else if(e.key.toLowerCase()==='o')openProject();else undo(e.key.toLowerCase()==='y'||e.shiftKey);}return;}
  if(e.repeat)return;
  if(e.code==='Space'){e.preventDefault();$('#pause').click();return;}
  if(e.code==='Escape'){project.blackout=false;learning=null;syncGlobals();return;}
  if(e.code==='Backquote'){$('#blackout').click();return;}
  if(/^F[1-3]$/.test(e.code)){e.preventDefault();const layer=project.layers[Number(e.code.slice(1))-1];if(layer){selectedLayerId=layer.id;inspectorTab='layer';renderLayers();renderInspector();}return;}
  if(/^Digit[0-9]$/.test(e.code)){const index=e.code==='Digit0'?9:Number(e.code.slice(-1))-1;if(e.shiftKey){e.preventDefault();beginColumnHold(index,heldKeys,e.code);return;}const layer=currentLayer(),clip=clipList(layer)[index];if(clip){const inputId=id(),held={layerId:layer.id,clipId:clip.id,inputId};if(preferences.clipPanelFollowsTrigger){selectClip(layer,clip,index);}heldKeys.set(e.code,held);trigger(layer,clip,()=>!transport.isPiano(clip)||heldKeys.get(e.code)===held,{inputId,selectedLayerId});renderInspector();}return;}
  const layer=currentLayer(),selected=currentClip(),clip=selected||findClip(layer.activeClipId)?.clip;
  if(e.code==='Enter'){e.preventDefault();if(e.target.dataset.column!==undefined){beginColumnHold(Number(e.target.dataset.column),heldKeys,e.code);return;}if(clip){const inputId=id(),owner=findClip(clip.id).layer,held={layerId:owner.id,clipId:clip.id,inputId};heldKeys.set(e.code,held);trigger(owner,clip,()=>!transport.isPiano(clip)||heldKeys.get(e.code)===held,{inputId,selectedLayerId});}return;}
  if(['ArrowLeft','ArrowRight'].includes(e.code)){e.preventDefault();const slots=clipList(layer),index=slots.findIndex(c=>c?.id===(selectedClipId||layer.activeClipId)),step=e.code==='ArrowLeft'?-1:1;for(let i=index+step;i>=0&&i<slots.length;i+=step){if(slots[i]){selectClip(layer,slots[i]);if(!e.shiftKey){const inputId=id(),held={layerId:layer.id,clipId:slots[i].id,inputId};heldKeys.set(e.code,held);trigger(layer,slots[i],()=>!transport.isPiano(slots[i])||heldKeys.get(e.code)===held,{inputId,selectedLayerId});}break;}}return;}
  if(!clip)return;
  const clipLayer=playingLayerFor(clip.id)||findClip(clip.id).layer;
  const cueIndex=['KeyQ','KeyW','KeyE','KeyR','KeyT','KeyY'].indexOf(e.code);
  if(cueIndex>=0){if(clipLayer.activeClipId!==clip.id)return toast('Trigger this clip before using cues.');if(e.shiftKey)transport.setCue(clipLayer.id,cueIndex);else transport.cue(clipLayer.id,cueIndex);changed();renderInspector();return;}
  const loops={KeyZ:0,KeyX:4,KeyC:2,KeyV:1,KeyB:.5,KeyN:.25};
  if(Object.hasOwn(loops,e.code)){clip.beatLoop=loops[e.code];changed();renderInspector();return;}
  if(e.code==='Comma'){clip.direction=-1;clip.paused=false;clip.random=false;}
  else if(e.code==='Period'){clip.direction=1;clip.paused=false;clip.random=false;}
  else if(e.code==='Slash'){e.preventDefault();clip.paused=!clip.paused;}
  else if(e.code==='KeyI'||e.code==='KeyO'){const state=transport.getState(clipLayer.id);if(state?.clipId!==clip.id)return;if(e.code==='KeyI')clip.inPoint=Math.min(state.position,clip.outPoint-.001);else clip.outPoint=Math.max(state.position,clip.inPoint+.001);}
  else return;
  changed();renderInspector();
}

function keyUp(e){if(shortcuts.handleKey(e,false))return;const held=heldKeys.get(e.code);if(held){releaseHeld(held);heldKeys.delete(e.code);}}
function undo(redo=false){if(historyTimer)commitHistory();const source=redo?redoStack:undoStack,destination=redo?undoStack:redoStack;if(!source.length)return;destination.push(snapshot());const data=source.pop();const oldUndo=undoStack,oldRedo=redoStack;loadProject(JSON.parse(data));undoStack=oldUndo;redoStack=oldRedo;lastHistory=data;changed(false);toast(redo?'Redo':'Undo');}
async function enableMidi(){try{midiAccess=await shortcuts.enableMidi();renderBrowser();toast('MIDI input enabled.');}catch(e){toast(`MIDI unavailable: ${e.message}`,true);}}
function midiMessage(event){const [status,number,value]=event.data,type=(status&0xf0)===0xb0?'cc':(status&0xf0)===0x90&&value>0?'note':null;if(!type)return;const channel=status&15;if(learning){if(project.mappings.length>=LIMITS.mappings)return toast('Mapping limit reached.');project.mappings.push({type,channel,number,target:learning});learning=null;changed();renderBrowser();toast('MIDI control assigned.');return;}for(const map of project.mappings)if(map.type===type&&map.channel===channel&&map.number===number)controlTarget(map.target,value/127);}
function controlTarget(target,value){if(target.startsWith('column:')){if(value>0)triggerColumn(+target.split(':')[1]);}else if(target.startsWith('layer:')){const [,layerId,property]=target.split(':');const layer=project.layers.find(l=>l.id===layerId);if(layer&&['opacity','volume'].includes(property))layer[property]=value;}else if(['crossfader','masterOpacity','masterVolume'].includes(target))project[target]=value;syncGlobals();}
let controlRefresh;
function applyControl(message){
  const address=message?.address??message?.path,args=(Array.isArray(message?.args)?message.args:message?.value===undefined?[]:[message.value]).map(arg=>arg&&typeof arg==='object'&&'value' in arg?arg.value:arg);
  if(typeof address==='string'&&shortcuts?.handleOSC(address,args))return;
  const handled=applyOSC({project,transport,triggerClip:(layer,clip)=>{const held={layerId:layer.id,clipId:clip.id,inputId:id()};oscHolds.set(clip.id,held);trigger(layer,clip,()=>!transport.isPiano(clip)||oscHolds.get(clip.id)===held,{inputId:held.inputId,selectedLayerId});},triggerColumn,
    stopLayer:layerId=>{triggerRequests.delete(layerId);transport.stop(layerId);},
    releaseClip:(layer,clip)=>{const held=oscHolds.get(clip.id);oscHolds.delete(clip.id);if(held)releaseHeld(held);else transport.release(layer.id,clip.id);},
    selectLayer:layerId=>{selectedLayerId=layerId;inspectorTab='layer';},
    selectClip:clipId=>{const found=findClip(clipId);if(found){selectedLayerId=found.layer.id;selectedClipId=clipId;inspectorTab='clip';if(preview)togglePreview();togglePreview();}}
  },message);
  if(handled){changed(false);if(!controlRefresh)controlRefresh=setTimeout(()=>{controlRefresh=null;syncGlobals();renderLayers();renderInspector();},100);}
}


function showDialog(title,body,buttons){const dialog=document.createElement('dialog');dialog.innerHTML=`<div class="panel-title"><h2>${esc(title)}</h2></div><div class="body">${body}</div><footer>${buttons.map(([label,value])=>`<button value="${value}" class="${value!=='cancel'?'primary':''}">${label}</button>`).join('')}</footer>`;document.body.append(dialog);for(const b of $$('footer button',dialog))b.onclick=()=>dialog.close(b.value);dialog.addEventListener('close',()=>setTimeout(()=>dialog.remove(),0));dialog.showModal();return dialog;}
function confirmDialog(title,text,yes){return new Promise(resolve=>{const dialog=showDialog(title,`<p>${esc(text)}</p>`,[['Cancel','cancel'],[yes,'yes']]);dialog.addEventListener('close',()=>resolve(dialog.returnValue==='yes'));});}
function editName(target,title,after){const dialog=showDialog(title,`<input id="new-name" type="text" value="${esc(target.name)}" maxlength="120" style="width:100%">`,[['Cancel','cancel'],['Apply','apply']]);$('#new-name',dialog).select();dialog.addEventListener('close',()=>{if(dialog.returnValue==='apply'){target.name=$('#new-name',dialog).value.trim()||target.name;after();}});}
function help(){showDialog('PrismVJ performance controls',`<div class="help-grid"><span><kbd>F1</kbd> to <kbd>F3</kbd></span><span>Select layer 1 to 3</span><span><kbd>1</kbd> to <kbd>0</kbd></span><span>Trigger clip in the selected layer</span><span><kbd>Shift + 1</kbd> to <kbd>0</kbd></span><span>Trigger a whole column</span><span><kbd>Q W E R T Y</kbd></span><span>Jump to cue; Shift to set cue</span><span><kbd>Z X C V B N</kbd></span><span>BeatLoopr off / 4 / 2 / 1 / 1/2 / 1/4</span><span><kbd>, . /</kbd></span><span>Reverse / forward / pause clip</span><span><kbd>I</kbd> / <kbd>O</kbd></span><span>Set clip in / out point</span><span><kbd>Left</kbd> / <kbd>Right</kbd></span><span>Trigger adjacent clip; Shift to select</span><span><kbd>Space</kbd></span><span>Pause / resume composition</span><span><kbd>Ctrl S</kbd> / <kbd>Ctrl O</kbd></span><span>Save / open composition</span><span><kbd>Ctrl Z</kbd> / <kbd>Ctrl Y</kbd></span><span>Undo / redo edits</span><span><kbd>Ctrl C / X / V</kbd></span><span>Copy / cut / paste selected clips</span><span>Right-click a clip</span><span>Select without triggering</span><span>Shift-click a clip</span><span>Select a range without triggering</span></div><p style="margin-top:18px;color:#9daabd">Deck changes preserve active playback. Layer order runs from bottom to top. Effects run on the clip, then layer, then composition. Recovery is saved automatically after edits.</p>`,[['Close','close']]);}


// Read-only diagnostics for automated runtime checks and support.
window.prismDiagnostics=()=>{
  const frames=transport.tick(now());
  return {project:serializeProject(project),preferences:{...preferences},
    frames:frames.map(frame=>({clipId:frame.clip.id,layerId:frame.layer.id,sourceLayerId:frame.sourceLayerId,voiceId:frame.voiceId,inputId:transport.getState(frame.layer.id)?.inputId,direction:frame.direction,position:frame.position,time:frame.time,weight:frame.weight})),
    voices:frames.map(frame=>{const voiceId=frame.sourceLayerId!==frame.layer.id?frame.voiceId:undefined;const media=engine.getMedia(frame.clip.id,voiceId),audio=engine.getAudio(frame.clip.id,voiceId);return {clipId:frame.clip.id,layerId:frame.layer.id,voiceId:frame.voiceId,mediaTime:media?.currentTime??null,audioTime:audio?.currentTime??null,mediaPaused:media?.paused??null,audioPaused:audio?.paused??null};}),
    stats:engine?.getStats?.(),recording:recorder?.state||'inactive',link:{available:link.available,enabled:link.enabled,peers:link.peers,tempo:link.tempo,beat:transport.beat},outputs:outputs?[...outputs.windows.values()].map(entry=>({name:entry.name,width:entry.canvas.width,height:entry.canvas.height})):[]};
};
// Renders the composition and every output window once, then samples each
// at its centre (for automated output checks).
window.prismOutputProbe=()=>{
  const t=now();engine.render(project,transport.tick(t),t,{beat:transport.beat});
  const center=[...(engine.readRegion(Math.floor(project.width/2),Math.floor(project.height/2),1,1)||[])];
  outputs.present(t);
  return {composition:center,outputs:[...outputs.windows.values()].map(entry=>entry.mapper.readPixel(Math.floor(entry.canvas.width/2),Math.floor(entry.canvas.height/2)))};
};

// Start last, so every module-level binding above is initialized first.
if (new URLSearchParams(location.search).has('output')) {
  document.body.innerHTML = '<canvas id="external-output" style="display:block;width:100vw;height:100vh;object-fit:contain;background:black"></canvas>';
  const canvas = $('#external-output'), ctx = canvas.getContext('2d');
  let decoding = false;
  desktop?.onOutputFrame(async bytes => {
    if (decoding) return;
    decoding = true;
    try { const bitmap = await createImageBitmap(new Blob([bytes], {type:'image/jpeg'})); if(canvas.width!==bitmap.width||canvas.height!==bitmap.height){canvas.width=bitmap.width;canvas.height=bitmap.height;} ctx.drawImage(bitmap,0,0); bitmap.close(); } finally { decoding=false; }
  });
  window.addEventListener('keydown', e => { if(e.code==='Escape') desktop?.closeOutput(); });
} else {
  initialize();
}
