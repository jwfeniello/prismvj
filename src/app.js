import './style.css';
import { createProject, createLayer, createClip, validateProject, serializeProject, Transport, LIMITS } from './model.js';
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
  if (!clip?.url) return '';
  const mov = clip.kind === 'video' && /\.mov$/i.test(clip.path || '') && /^prism-media:/i.test(clip.url);
  if (clip.kind !== 'image' && !mov) return '';
  const url = mov ? `${clip.url}${clip.url.includes('?') ? '&' : '?'}thumbnail=1` : clip.url;
  return `<img src="${esc(url)}" alt="" loading="lazy">`;
};
const id = () => crypto.randomUUID();
const now = () => performance.now() / 1000;
const desktop = window.desktop;
const effects = ['invert','grayscale','brightness','contrast','saturation','hue','pixelate','mirror','kaleidoscope','strobe'];
const sourceTypes = ['plasma','grid','rings','noise','solid'];
const sourceDescriptions = ['Flowing color fields','Perspective line pattern','Concentric waves','Animated texture','Solid color generator'];
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
let lastPaint=0,paintFrames=0,paintStart=0,lastActive='';
const layerPlayheads=new Map(),clipPlayheads=new Map(),queuedSlots=new Map();
let inspectorPlayhead=null,inspectorTime=null;
const snapshot = () => JSON.stringify(validateProject(project));

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

function initialize() {
  $('#app').innerHTML = `
    <header class="topbar"><div class="brand">Prism Live</div><input type="text" class="project-title" id="project-name" aria-label="Composition name" value="${esc(project.name)}"><span class="pill" id="save-state">LOCAL SESSION</span><div class="spacer"></div><button id="new-project">New</button><button id="open-project">Open</button><button id="save-project">Save</button><div class="divider"></div><button id="record">● Record</button><button id="output" class="primary">Output</button><button id="preferences" title="Preferences">Settings</button><button id="help" title="Keyboard shortcuts">?</button></header>
    <div class="toolbar"><label>BPM</label><input id="bpm" class="tempo" type="number" min="20" max="300" step=".1" value="${project.bpm}" aria-label="Tempo"><button id="tap" class="icon-btn">Tap</button><button id="resync" class="icon-btn" title="Resync beat clock">↻</button><div class="divider"></div><label>Quantize</label><select id="quantize" aria-label="Trigger quantization"><option value="0">Immediate</option><option value=".25">¼ beat</option><option value="1">1 beat</option><option value="4">1 bar</option><option value="8">2 bars</option></select><div class="divider"></div><button data-global-direction="backward" class="icon-btn" title="Reverse all active clips; right-click to pin">◀</button><button data-global-direction="forward" class="icon-btn" title="Forward all active clips; right-click to pin">▶</button><button data-global-direction="random" class="icon-btn" title="Random playback; right-click to pin">R</button><button id="pause" class="icon-btn" title="Pause composition; right-click to pin paused clip launches">Ⅱ Pause</button><label>Speed</label><input id="global-speed" aria-label="Global speed" type="range" min=".1" max="4" step=".01" value="1"><output id="speed-value">1.00×</output><div class="spacer"></div><button id="bypass-all" class="icon-btn">Bypass all</button><button id="clear-all" class="icon-btn">Clear all</button><button id="blackout" class="icon-btn">Blackout</button></div>
    <section class="workspace"><div class="layer-label row"><span class="muted">Composition</span><div class="spacer"></div><button id="insert-layer" class="icon-btn" title="Insert layer below selected">↧</button><button id="add-layer" class="icon-btn" title="Add layer">+</button></div><div id="column-viewport"><div id="column-heads" class="column-heads"></div></div><div id="layer-bank" class="layer-bank"></div></section>
    <nav class="deckbar"><div class="crossfade"><button id="cross-a" title="Fade to A">A</button><input id="crossfader" type="range" min="0" max="1" step=".001" value=".5" aria-label="Crossfader"><button id="cross-b" title="Fade to B">B</button></div><div id="decks" class="row"></div><button id="add-deck" class="icon-btn" title="Add deck">+</button><button id="deck-actions" class="icon-btn" title="Edit selected deck">Deck…</button><button id="column-actions" class="icon-btn" title="Edit columns">Columns…</button><span class="spacer"></span><button id="copy-clip" class="icon-btn" title="Copy selected clip (Ctrl+C)">Copy</button><button id="cut-clip" class="icon-btn" title="Cut selected clip (Ctrl+X)">Cut</button><button id="paste-clip" class="icon-btn" title="Paste into selected slot (Ctrl+V)">Paste</button></nav>
    <div class="layout-splitter horizontal" data-layout-splitter="workspace" role="separator" aria-label="Resize top and bottom sections" aria-orientation="horizontal" tabindex="0"></div>
    <main class="bottom"><section class="monitor-panel"><div class="panel-title"><span id="monitor-label">Composition Monitor</span><span id="frame-count" class="muted">60 FPS</span></div><div class="monitor-wrap"><canvas id="output-canvas" width="1280" height="720"></canvas></div><div class="monitor-caption"><span id="live-label">Composition</span><span id="resolution">1280 × 720</span></div><div class="layout-splitter horizontal" data-layout-splitter="monitors" role="separator" aria-label="Resize composition and preview monitors" aria-orientation="horizontal" tabindex="0"></div><div class="panel-title preview-title"><span>Preview Monitor</span><button id="preview-toggle" title="Preview selected clip">Preview selected</button></div><div id="preview-wrap" class="monitor-wrap preview-wrap"><span class="preview-empty">Click a clip name to preview</span></div><div class="monitor-caption"><span id="preview-label">Preview · No clip selected</span></div><div class="monitor-footer"><label>Video</label><input id="master-opacity" type="range" min="0" max="1" step=".01" value="1" aria-label="Master video"><label>Audio</label><input id="master-volume" type="range" min="0" max="1" step=".01" value="1" aria-label="Master audio"><span id="audio-meter">—</span></div></section>
    <div class="layout-splitter vertical" data-layout-splitter="panel-0" role="separator" aria-label="Resize monitor and composition panels" aria-orientation="vertical" tabindex="0"></div>
    <section class="inspector-panel context-panel"><div class="transport-tabs"><button data-inspector="composition">Composition</button><button data-inspector="layer">Layer</button></div><div data-inspector-panel="context" class="inspector-content"></div></section>
    <div class="layout-splitter vertical" data-layout-splitter="panel-1" role="separator" aria-label="Resize composition and clip panels" aria-orientation="vertical" tabindex="0"></div>
    <section class="inspector-panel clip-panel"><div class="transport-tabs"><button data-inspector="clip" class="active">Clip</button></div><div data-inspector-panel="clip" class="inspector-content"></div></section>
    <div class="layout-splitter vertical" data-layout-splitter="panel-2" role="separator" aria-label="Resize clip and browser panels" aria-orientation="vertical" tabindex="0"></div>
    <section class="browser-panel"><div class="browser-tabs"><button data-browser="files">Files</button><button data-browser="effects">Effects</button><button data-browser="sources" class="active">Sources</button><button data-browser="controls">Control</button></div><div id="browser" class="browser-content"></div></section></main>
    <footer class="statusbar"><span class="status-dot"></span><span id="status-text">Ready</span><span class="spacer"></span><span id="memory-status"></span><span id="beat-status">BEAT 1.1</span><span>PRISM LIVE 0.1</span></footer>`;
  $('.deckbar').after($('[data-layout-splitter="workspace"]'),$('.toolbar'));
  installResizableLayout($('#app'));
  const snapshotButton=document.createElement('button');snapshotButton.id='snapshot-output';snapshotButton.textContent='Snapshot';snapshotButton.title='Save the current output as PNG';$('#record').before(snapshotButton);
  engine = new LiveEngine($('#output-canvas'), {onError: message => toast(message, true)});
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
function changed(history=true){dirty=true;$('#save-state').textContent='UNSAVED';clearTimeout(saveTimer);saveTimer=setTimeout(autosave,800);if(history){const value=snapshot();if(value!==lastHistory){undoStack.push(lastHistory);if(undoStack.length>60)undoStack.shift();redoStack=[];lastHistory=value;}}}
async function autosave(){try{const data=serializeProject(project);if(desktop)await desktop.autosave(data);else localStorage.setItem('prism-recovery',JSON.stringify(data));$('#save-state').textContent=dirty?'RECOVERY SAVED':'SAVED';}catch(e){toast(`Recovery could not be saved: ${e.message}`,true);}}
function renderAll(){renderLayers();renderDecks();renderInspector();renderBrowser();syncGlobals();}
function applyPreferences(){
  document.documentElement.dataset.showAudio=String(preferences.showAudioControls);
  document.documentElement.dataset.layerTransport=String(preferences.showLayerTransport);
  document.documentElement.dataset.transitions=String(preferences.showTransitions);
}
function preferencesDialog(){
  const labels={clipPanelFollowsTrigger:'Clip panel follows triggered clips',showAudioControls:'Show audio controls',showLayerTransport:'Show transport in each layer',showTransitions:'Show transition controls in each layer'};
  const dialog=showDialog('Preferences',Object.entries(labels).map(([key,label])=>`<label class="preference-option"><input data-preference="${key}" type="checkbox" ${preferences[key]?'checked':''}>${label}</label>`).join('')+'<p class="browser-note">These settings apply to this computer and survive reopening Prism Live.</p>',[['Cancel','cancel'],['Save settings','save']]);
  dialog.addEventListener('close',()=>{if(dialog.returnValue!=='save')return;try{preferences=writePreferences(Object.fromEntries($$('[data-preference]',dialog).map(input=>[input.dataset.preference,input.checked])));applyPreferences();renderAll();}catch(error){toast('Settings could not be saved: '+error.message,true);}});
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

function renderLayers(){
  document.documentElement.style.setProperty('--columns',project.columns||8);
  renderColumns();
  lastActive=project.layers.map(l=>l.activeClipId).join(',');
  $('#layer-bank').innerHTML=[...project.layers].reverse().map(layer=>`<div class="layer-row" data-layer="${layer.id}">${layerHeader(layer)}<div class="clips">${clipList(layer).map((clip,index)=>clip?`<button class="clip-slot ${selectedClips.has(clip.id)?'selected':''} ${project.layers.some(item=>item.activeClipId===clip.id)?'playing':''}" data-slot="${index}" data-clip="${clip.id}" draggable="true" title="${esc(clip.name)} — click to trigger, right-click to edit"><div class="clip-art ${esc(clip.kind==='source'?clip.source:clip.kind)}" style="${clip.source==='solid'?`background:${esc(clip.color)}`:''}">${clipThumbnail(clip)}<span class="clip-kind">${clip.kind==='source'?'GEN':esc(clip.kind.toUpperCase())}</span></div><span class="clip-name">${esc(clip.name)}</span><div class="clip-progress"></div></button>`:`<button class="clip-slot empty-slot ${layer.id===selectedLayerId&&index===selectedColumn&&!selectedClipId?'selected':''}" data-slot="${index}" title="Drop media or double-click to import">+</button>`).join('')}</div></div>`).join('');
  for(const row of $$('.layer-row')){
    const layer=project.layers.find(l=>l.id===row.dataset.layer);
    $('[data-layer-select]',row).onclick=()=>{selectedLayerId=layer.id;inspectorTab='layer';renderLayers();renderInspector();};
    for(const input of $$('[data-layer-prop]',row)) input.oninput=()=>{layer[input.dataset.layerProp]=input.type==='range'?+input.value:input.value;changed();};
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
      slot.oncontextmenu=e=>{e.preventDefault();selectClip(layer,clip,index);};
      slot.ondblclick=()=>{if(!clip)importFiles(layer,index);};
      slot.onpointerdown=e=>{if(e.button===0&&!e.shiftKey&&!e.target.closest('.clip-name')&&clip&&transport.isPiano(clip)){const inputId=id(),held={layerId:layer.id,clipId:clip.id,inputId};heldPointers.set(e.pointerId,held);trigger(layer,clip,()=>heldPointers.get(e.pointerId)===held,{selectedLayerId,inputId});}};
      slot.ondragstart=e=>{if(clip)e.dataTransfer.setData('application/prism-clip',JSON.stringify({layerId:layer.id,clipId:clip.id}));};
      slot.ondragover=e=>{e.preventDefault();slot.classList.add('drag-over');};
      slot.ondragleave=()=>slot.classList.remove('drag-over');
      slot.ondrop=async e=>{
        e.preventDefault();slot.classList.remove('drag-over');
        try{
          const source=e.dataTransfer.getData('application/prism-source'),move=e.dataTransfer.getData('application/prism-clip'),path=e.dataTransfer.getData('application/prism-path');
          if(source)addSource(source,layer,index);
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
    const slider=host.querySelector(`[data-prop="${key}"]`),number=host.querySelector(`[data-number="${key}"]`);
    const value=target[key]*(slider?.dataset.unit==='pixels'?(key==='x'?project.width:project.height):1);
    if(slider)slider.value=value;
    if(number)number.value=Number(value).toFixed(2);
    changed();if(scope==='composition')syncGlobals();
  };
  for(const input of $$('[data-dashboard-value]',host))input.style.setProperty('--dial-progress',`${Number(input.value)*280}deg`);
}
function renderExtras(target,inspectorTab){
  const mask=target.mask;
  const orders=[['effects','mask','transform'],['effects','transform','mask'],['mask','effects','transform'],['mask','transform','effects'],['transform','effects','mask'],['transform','mask','effects']];
  let html='<div class="section">';
  if(inspectorTab==='clip')html+=`<h3>Media components</h3><div class="row"><label><input id="use-video" type="checkbox" ${target.useVideo?'checked':''}> Video</label><label><input id="use-audio" type="checkbox" ${target.useAudio?'checked':''}> Audio</label><button id="attach-audio" class="icon-btn">Pair audio…</button></div>${componentFields(target)}${select('Video fit','fit',target.fit,['width','height','stretch','original','contain','cover'])}${target.audio?`<div class="component-path" title="${esc(target.audio.path||target.audio.url)}">Audio: ${esc((target.audio.path||'Paired audio').split(/[\\/]/).pop())} · ${target.audio.duration.toFixed(2)} s</div><div class="row"><button id="relink-audio" class="icon-btn">Reconnect audio</button><button id="detach-audio" class="icon-btn">Unpair audio</button></div>`:''}${target.kind==='video'?'<div class="row" style="margin-top:8px"><button id="remove-video" class="icon-btn">Remove video, keep audio</button></div>':''}${desktop&&target.path?'<button id="reveal-media" class="icon-btn" style="margin-top:8px">Show in Explorer</button>':''}`;
  if(inspectorTab!=='composition')html+=`<label class="select-field"><span>Ignore column trigger</span><input id="ignore-column" type="checkbox" ${target.ignoreColumn?'checked':''}></label>`;
  if(inspectorTab!=='clip')html+=range('Linked AV','av',target.av,0,1);
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
function effectStack(target){return `<div class="section"><div class="row"><h3 class="grow">Effects</h3><button id="browse-effects" class="icon-btn">+ Add effect</button></div>${target.effects.map((fx,index)=>`<div class="effect-card" data-effect="${fx.id}"><div class="row"><input type="checkbox" data-fx="enabled" ${fx.enabled?'checked':''} aria-label="Enable ${fx.type}"><span class="grow">${esc(fx.type)}</span><button data-fx-up="${index}" title="Move effect up">↑</button><button data-fx-remove="${index}" title="Remove effect">×</button></div><div class="field"><label>Amount</label><input data-fx="amount" type="range" min="0" max="1" step=".01" value="${fx.amount}" aria-label="${fx.type} amount"><output>${fx.amount.toFixed(2)}</output></div></div>`).join('')||'<small>Add effects from the Effects browser.</small>'}</div>`;}
function inspectorQueries(host,prefix){
  const selectorFor=selector=>selector.replace(/#([a-zA-Z][\w-]*)/g,(_,value)=>'#'+prefix+value);
  return {$:(selector,parent=host)=>selector==='#inspector'?host:parent.querySelector(selectorFor(selector)),$$:(selector,parent=host)=>[...parent.querySelectorAll(selectorFor(selector))]};
}
function activateInspector(scope){inspectorTab=scope;renderInspector();}
function renderInspector(){
  effectScope=inspectorTab;
  if(inspectorTab!=='clip')contextTab=inspectorTab;
  for(const button of $$('[data-inspector]'))button.classList.toggle('active',button.dataset.inspector===contextTab||button.dataset.inspector==='clip');
  for(const [scope,name] of [[contextTab,'context'],['clip','clip']]){
    const host=$('[data-inspector-panel="'+name+'"]'),scroll=host.scrollTop,active=scope===inspectorTab;
    host.id=active?'inspector':'secondary-inspector';host.dataset.active=String(active);host.dataset.scope=scope;
    host.onpointerdown=()=>{effectScope=scope;if(browserTab==='effects')renderBrowser();};
    renderInspectorPanel(scope,host,active?'':'secondary-');host.scrollTop=scroll;
  }
  const clipPanel=$('[data-inspector-panel="clip"]');
  inspectorPlayhead=$('.timeline',clipPanel);
  inspectorTime=$('.time-labels span',clipPanel);
}
function decorateInspector(host,scope){
  const sections=[...host.querySelectorAll(':scope > .section')];
  const titled=name=>sections.find(section=>section.querySelector('h3')?.textContent.startsWith(name));
  const makeSection=(title,before)=>{const section=document.createElement('div');section.className='section';const heading=document.createElement('h3');heading.textContent=title;section.append(heading);host.insertBefore(section,before);return section;};
  const moveField=(key,section)=>{const field=host.querySelector('[data-prop="'+key+'"]')?.closest('.field');if(field)section.append(field);};
  if(scope==='composition'){
    const settings=titled('Composition settings');
    if(settings){
      const main=makeSection('Composition',settings);moveField('av',main);
      const audio=makeSection('Audio',settings);audio.classList.add('audio-section');moveField('masterVolume',audio);moveField('pan',audio);
      const video=makeSection('Video',settings);moveField('masterOpacity',video);
      const crossfader=makeSection('CrossFader',settings);moveField('crossfader',crossfader);
      host.append(settings);
    }
  }
  if(scope==='clip'){
    const transportSection=titled('Transport'),transform=titled('Transform'),video=titled('Video & audio'),components=titled('Media components');
    if(transportSection){
      const advanced=makeSection('Trigger & playback',null);
      for(const field of [...transportSection.querySelectorAll(':scope > .select-field')])advanced.append(field);
      for(const key of ['inPoint','outPoint'])moveField(key,advanced);
      for(const heading of [...transportSection.querySelectorAll(':scope > h3')].slice(1)){
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
  const layer=currentLayer(),clip=currentClip(),target=inspectorTab==='composition'?project:inspectorTab==='layer'?layer:clip;
  if(!target){$('#inspector').innerHTML='<div class="empty">Select a clip to see its transport,<br>transform, and effect controls.<br><br>Right-click selects without triggering.</div>';return;}
  let html=`<div class="section"><div class="row"><h2 class="grow">${esc(target.name)}</h2><button id="rename" class="icon-btn">Rename</button>${inspectorTab==='clip'?'<button id="remove-clip" class="icon-btn danger">Remove</button>':''}</div></div>`;
  html+=dashboardSection(target,inspectorTab);
  if(inspectorTab==='clip')html+=`<div class="section clip-persistence"><h3>Deck behavior</h3><label><input id="clip-persistent" type="checkbox" ${clip.persistent?'checked':''}> Persistent across decks</label><small>Shows this clip in the same layer and column on every deck. Covered clips stay in their original deck.</small></div>`;
  if(inspectorTab==='clip')html+=`<div class="section clip-label-color"><h3>Clip label</h3><div class="row"><label>Highlight <input id="clip-label-color" type="color" value="${esc(clip.labelColor||'#8affd7')}"></label><button id="clear-clip-label" class="icon-btn">Clear color</button></div></div>`;
  if(inspectorTab==='clip')html+=`<div class="section"><h3>Snapshot</h3><button id="snapshot-clip" class="icon-btn">Save clip frame as PNG</button></div>`;
  if(inspectorTab==='clip')html+=`<div class="section"><h3>Transport <span class="muted">· ${esc(clip.kind)}</span></h3><div class="transport-buttons"><button data-direction="-1" class="${clip.direction===-1&&!clip.paused?'active':''}">◀ Reverse</button><button id="clip-pause" class="${clip.paused?'active':''}">Ⅱ Pause</button><button data-direction="1" class="${clip.direction===1&&!clip.paused?'active':''}">▶ Forward</button><button id="retrigger">↻</button></div><input id="timeline" class="timeline" type="range" min="0" max="1" step=".001" value="0" aria-label="Clip playhead"><div class="time-labels"><span id="clip-time">00:00.00</span><span>${clip.duration.toFixed(2)} s</span></div>${select('Playback','loop',clip.loop,['loop','once','once-clear','pingpong','random'])}${select('Restart behavior','trigger',clip.trigger,['restart','continue','piano'])}${select('Trigger style','triggerStyle',clip.triggerStyle,['inherit','normal','piano'])}${select('Clip target','clipTarget',clip.clipTarget,['inherit','own','selected','free'])}<div class="select-field"><label>Beat snap</label><select id="clip-quantize">${[[null,'Composition'],[0,'Immediate'],[.25,'1/4 beat'],[1,'1 beat'],[4,'1 bar'],[8,'2 bars']].map(([v,label])=>`<option value="${v===null?'inherit':v}" ${clip.quantize===v?'selected':''}>${label}</option>`).join('')}</select></div>${select('Autopilot','autoPilot',clip.autoPilot,['inherit','off','next','previous','random'])}<div class="select-field"><label for="beat-sync">BPM sync</label><input id="beat-sync" type="checkbox" ${clip.beatSync?'checked':''}><label>Beats</label><input id="clip-beats" aria-label="Clip beats" type="number" min=".25" max="1024" step=".25" value="${clip.beats}" style="width:65px"></div>${range('Speed','speed',clip.speed,.1,4)}${range('In point','inPoint',clip.inPoint,0,.99)}${range('Out point','outPoint',clip.outPoint,.01,1)}<h3 style="margin-top:14px">BeatLoopr</h3><div class="cue-buttons">${[0,4,2,1,.5,.25].map(v=>`<button data-beat-loop="${v}" class="${clip.beatLoop===v?'active':''}">${v||'Off'}</button>`).join('')}</div><h3 style="margin-top:14px">Cue points <small>Shift-click to set</small></h3><div class="cue-buttons">${clip.cues.map((c,i)=>`<button data-cue="${i}" title="${(c*100).toFixed(1)}%">${i+1} · ${(c*100).toFixed(0)}%</button>`).join('')}</div></div><div class="section"><h3>Video & audio</h3>${range('Opacity','opacity',clip.opacity,0,1)}${range('Volume','volume',clip.volume,0,4)}${range('Pan','pan',clip.pan,-1,1)}${clip.kind==='source'?`<div class="select-field"><label>Duration (s)</label><input id="source-duration" type="number" value="${clip.duration}" min=".1" max="3600" step=".1" style="width:90px"></div><div class="select-field"><label>Color</label><input type="color" id="source-color" value="${esc(clip.color)}"></div>`:''}${clip.kind!=='source'?'<div class="row"><button id="relink-clip">Reconnect media</button></div>':''}${clip.path?`<small title="${esc(clip.path)}">${esc(clip.path.split(/[\\/]/).pop())}</small>`:''}</div>`;
  if(inspectorTab==='layer')html+=`<div class="section"><h3>Layer mixing</h3>${range('Video','opacity',layer.opacity,0,1)}${range('Audio','volume',layer.volume,0,1)}${range('Pan','pan',layer.pan,-1,1)}<div class="select-field"><label for="prop-blend">Blend mode</label><select id="prop-blend" data-prop="blend">${blendOptions(layer.blend)}</select></div>${select('Crossfader','group',layer.group,['none','A','B'])}${range('Transition (s)','transition',layer.transition,0,10,'.1')}<div class="select-field"><label for="prop-transitionMode">Transition mode</label><select id="prop-transitionMode" data-prop="transitionMode">${blendOptions(layer.transitionMode,true)}</select></div>${select('Autopilot','autoPilot',layer.autoPilot,['off','next','previous','random'])}<div class="row"><button id="move-layer-up">Move up</button><button id="move-layer-down">Move down</button><button id="remove-layer" class="danger">Remove layer</button></div></div>`;
  if(inspectorTab==='composition')html+=compositionSettings(project,range);
  html+=transformFields(target,project,inspectorTab)+renderExtras(target,inspectorTab)+effectStack(target);host.innerHTML=html.replace(/\b(id|for)="([^"]+)"/g,(_,attribute,value)=>attribute+'="'+prefix+value+'"');bindExtras(target,inspectorTab,host,prefix);
  const targets=inspectorTargets(target,inspectorTab);
  const setProperty=(key,value,input)=>{
    if(input.type==='range'||input.type==='number'){
      if(value===''||!Number.isFinite(Number(value)))return;
      value=Math.max(Number(input.min),Math.min(Number(input.max),Number(value)));
    }
    if(input.dataset.unit==='pixels')value/=input.dataset.prop==='x'||input.dataset.number==='x'?project.width:project.height;
    for(const item of targets){let next=value;if(key==='inPoint')next=Math.min(next,item.outPoint-.001);if(key==='outPoint')next=Math.max(next,item.inPoint+.001);item[key]=next;syncDashboard(item,inspectorTab,key);}
    const slider=$('[data-prop="'+key+'"]',$('#inspector')),number=$('[data-number="'+key+'"]',$('#inspector'));
    const display=typeof target[key]==='number'?target[key]*(input.dataset.unit==='pixels'?(key==='x'?project.width:project.height):1):target[key];if(slider)slider.value=display;if(number&&number!==document.activeElement)number.value=Number(display).toFixed(2);
    for(const dial of $$('[data-dashboard-value]',host))if(target.dashboard[Number(dial.dataset.dashboardValue)]?.key===key){dial.value=target.dashboard[Number(dial.dataset.dashboardValue)].value;dial.style.setProperty('--dial-progress',`${Number(dial.value)*280}deg`);}
    changed();if(inspectorTab!=='clip')syncGlobals();
  };
  for(const input of $$('[data-prop]',$('#inspector'))){
    input.oninput=()=>setProperty(input.dataset.prop,input.value,input);
    if(input.type==='range'){const reset=event=>{event.preventDefault();const key=input.dataset.prop;const defaults={opacity:1,volume:1,masterOpacity:1,masterVolume:1,av:1,scale:1,speed:1,outPoint:1,crossfader:.5,width:target.nativeWidth||project.width,height:target.nativeHeight||project.height};setProperty(key,defaults[key]??0,input);};input.ondblclick=reset;input.oncontextmenu=reset;$('label[for="'+input.id+'"]',$('#inspector')).oncontextmenu=reset;}
  }
  for(const input of $$('[data-number]',$('#inspector')))input.onchange=()=>{setProperty(input.dataset.number,input.value,input);input.value=Number(target[input.dataset.number]*(input.dataset.unit==='pixels'?(input.dataset.number==='x'?project.width:project.height):1)).toFixed(2);};
  $('#rename').onclick=()=>editName(target,'Name',()=>{changed();renderAll();});
  $('#browse-effects').onclick=()=>{activateInspector(inspectorTab);browserTab='effects';renderBrowser();};
  for(const card of $$('[data-effect]')){const fx=target.effects.find(e=>e.id===card.dataset.effect);for(const input of $$('[data-fx]',card))input.oninput=()=>{fx[input.dataset.fx]=input.type==='checkbox'?input.checked:+input.value;if(input.type==='range')input.nextElementSibling.textContent=fx.amount.toFixed(2);changed();};$('[data-fx-remove]',card).onclick=()=>{target.effects=target.effects.filter(e=>e!==fx);changed();renderInspector();};$('[data-fx-up]',card).onclick=()=>{const i=target.effects.indexOf(fx);if(i>0)[target.effects[i-1],target.effects[i]]=[target.effects[i],target.effects[i-1]];changed();renderInspector();};}
  if(clip&&inspectorTab==='clip'){
    for(const b of $$('[data-direction]'))b.onclick=()=>{clip.direction=+b.dataset.direction;clip.paused=false;changed();renderInspector();};
    $('#clip-pause').onclick=()=>{clip.paused=!clip.paused;changed();renderInspector();};
    $('#retrigger').onpointerdown=event=>{if(event.button!==0||!transport.isPiano(clip))return;const inputId=id(),owner=findClip(clip.id).layer,held={layerId:owner.id,clipId:clip.id,inputId};heldPointers.set(event.pointerId,held);trigger(owner,clip,()=>heldPointers.get(event.pointerId)===held,{inputId,selectedLayerId});};
    $('#retrigger').onclick=()=>{if(!transport.isPiano(clip))trigger(findClip(clip.id).layer,clip);};
    $('#timeline').oninput=e=>{const layer=playingLayerFor(clip.id)||findClip(clip.id).layer;if(layer.activeClipId===clip.id)transport.seek(layer.id,+e.target.value);else toast('Trigger this clip before moving its live playhead.');};
    $('#beat-sync').onchange=e=>{clip.beatSync=e.target.checked;changed();};
    $('#clip-quantize').onchange=e=>{clip.quantize=e.target.value==='inherit'?null:+e.target.value;changed();};
    for(const b of $$('[data-beat-loop]'))b.onclick=()=>{clip.beatLoop=+b.dataset.beatLoop;changed();renderInspector();};
    $('#source-duration')?.addEventListener('change',e=>{clip.duration=Math.max(.1,Math.min(3600,+e.target.value||5));changed();renderInspector();});
    $('#clip-beats').onchange=e=>{clip.beats=Math.max(.25,Math.min(1024,+e.target.value||16));changed();};
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
  bindDashboard(host,target,inspectorTab);
  if(inspectorTab==='composition'){
    $('#composition-description').onchange=event=>{project.description=event.target.value;changed();};
    const resize=(width,height)=>{width=Number(width);height=Number(height);if(!Number.isInteger(width)||!Number.isInteger(height)||width<64||height<64||width>8192||height>8192)return toast('Use whole-number dimensions from 64 to 8192 pixels.',true);try{engine.resize(width,height);project.width=width;project.height=height;changed();syncGlobals();renderInspector();}catch(error){toast(error.message,true);}};
    $('#composition-size').onchange=event=>resize(...event.target.value.split(','));
    $('#apply-composition-size').onclick=()=>resize($('#composition-width').value,$('#composition-height').value);
    $('#save-as').onclick=()=>saveProject(true);
  }
}

function renderBrowser(){
  for(const b of $$('[data-browser]'))b.classList.toggle('active',b.dataset.browser===browserTab);
  if(browserTab==='sources')$('#browser').innerHTML='<div class="browser-note">Drag a source into a clip slot, or click to add to the selected layer.</div>'+sourceTypes.map((s,i)=>`<div class="browser-item" data-source="${s}" draggable="true"><div class="source-icon clip-art ${s}"></div><div><strong>${s[0].toUpperCase()+s.slice(1)}</strong><small>${sourceDescriptions[i]}</small></div><span class="spacer"></span><span class="muted">＋</span></div>`).join('');
  if(browserTab==='effects')$('#browser').innerHTML=`<div class="browser-note">Click an effect to add it to the selected <strong>${effectScope}</strong>. Effects process from top to bottom.</div>`+effects.map(s=>`<div class="browser-item" data-add-effect="${s}"><span class="pill">FX</span><strong>${s[0].toUpperCase()+s.slice(1)}</strong><span class="spacer"></span><span class="muted">＋</span></div>`).join('');
  if(browserTab==='files'){fileBrowser.render($('#browser'));return;}else fileBrowser.detach();
  if(browserTab==='controls')$('#browser').innerHTML=`<div class="section"><h3>Performance controls</h3><p class="browser-note">Number keys 1–0 trigger the selected layer; Shift triggers a column. Q–I trigger the top layer; A–K the middle; Z–comma the bottom. Space pauses. Escape clears blackout.</p><button id="enable-midi">${midiAccess?'MIDI connected':'Enable MIDI input'}</button><p id="midi-status" class="browser-note">${midiAccess?[...midiAccess.inputs.values()].map(x=>esc(x.name)).join(', ')||'No MIDI inputs detected':'Connect a controller, then enable MIDI.'}</p></div><div class="section"><h3>MIDI learn</h3><select id="learn-target"><option value="crossfader">Crossfader</option><option value="masterOpacity">Master video</option><option value="masterVolume">Master audio</option>${project.layers.map((l,i)=>`<option value="layer:${l.id}:opacity">${esc(l.name)} video</option>`).join('')}${Array.from({length:project.columns||8},(_,i)=>`<option value="column:${i}">Column ${i+1}</option>`).join('')}</select><button id="midi-learn" class="icon-btn">Learn</button><div id="mappings">${project.mappings.map((m,i)=>`<div class="mapping"><small class="grow">${esc(m.target)} ← ${m.type} ${m.number}</small><button data-unmap="${i}" class="icon-btn">×</button></div>`).join('')}</div></div>${desktop?.startOSC?'<div class="section"><h3>OSC input</h3><div class="row"><input id="osc-port" aria-label="OSC port" type="number" min="1024" max="65535" value="7000" style="width:80px"><button id="osc-start">Start OSC</button><button id="osc-stop">Stop</button></div><p class="browser-note">Local UDP input. /composition/video/fadeout/values, /layer1/audio/pan/values, /layer1/clip1/connect, /layer1/video/opacity/values.</p></div>':''}`;
  for(const item of $$('[data-source]')){item.onclick=()=>addSource(item.dataset.source);item.ondragstart=e=>e.dataTransfer.setData('application/prism-source',item.dataset.source);}
  for(const item of $$('[data-add-effect]'))item.onclick=()=>{const target=effectScope==='composition'?project:effectScope==='layer'?currentLayer():currentClip();if(!target)return toast('Select a clip or layer first.');if(target.effects.length>=LIMITS.effects)return toast('Effect stack limit reached.');target.effects.push({id:id(),type:item.dataset.addEffect,enabled:true,amount:.5});changed();activateInspector(effectScope);};
  $('#import-media')?.addEventListener('click',()=>importFiles());
  for(const item of $$('[data-library]'))item.onclick=()=>placeMedia(mediaLibrary[+item.dataset.library],currentLayer());
  $('#enable-midi')?.addEventListener('click',enableMidi);
  $('#midi-learn')?.addEventListener('click',()=>{learning=$('#learn-target').value;toast('Move a MIDI control or press a note to assign it.');});
  for(const b of $$('[data-unmap]'))b.onclick=()=>{project.mappings.splice(+b.dataset.unmap,1);changed();renderBrowser();};
  $('#osc-start')?.addEventListener('click',async()=>{try{const result=await desktop.startOSC(+$('#osc-port').value);toast(`OSC listening on port ${result?.port||$('#osc-port').value}`);}catch(e){toast(e.message,true);}});
  $('#osc-stop')?.addEventListener('click',async()=>{await desktop.stopOSC();toast('OSC stopped.');});
}

function bindStatic(){
  for(const [selector,key] of [['#project-name','name'],['#bpm','bpm'],['#quantize','quantize'],['#global-speed','speed'],['#crossfader','crossfader'],['#master-opacity','masterOpacity'],['#master-volume','masterVolume']])$(selector).oninput=e=>{project[key]=key==='name'?e.target.value:+e.target.value;if(key==='bpm')project.bpm=Math.max(20,Math.min(300,project.bpm||120));$('#speed-value').textContent=project.speed.toFixed(2)+'×';changed();};
  $('#pause').onclick=()=>{project.paused=!project.paused;changed();syncGlobals();};
  const direction=(mode,pin=false)=>{if(pin&&project.directionPin===mode)project.directionPin=null;else transport.setGlobalDirection(mode,{pin});changed();syncGlobals();renderInspector();};
  for(const button of $$('[data-global-direction]')){button.onclick=()=>direction(button.dataset.globalDirection);button.oncontextmenu=event=>{event.preventDefault();direction(button.dataset.globalDirection,true);};}
  $('#pause').oncontextmenu=event=>{event.preventDefault();direction('pause',true);};
  $('#bypass-all').onclick=()=>{project.bypass=!project.bypass;changed();syncGlobals();};
  $('#preferences').onclick=preferencesDialog;
  $('#blackout').onclick=()=>{project.blackout=!project.blackout;syncGlobals();};
  $('#clear-all').onclick=()=>{triggerRequests.clear();for(const l of project.layers)transport.stop(l.id);renderLayers();};
  $('#resync').onclick=()=>transport.resync?.(now());
  $('#tap').onclick=()=>{const t=now();if(t-(tapTimes.at(-1)||0)>2)tapTimes=[];tapTimes.push(t);if(tapTimes.length>6)tapTimes.shift();if(tapTimes.length>1){project.bpm=Math.max(20,Math.min(300,60*(tapTimes.length-1)/(t-tapTimes[0])));$('#bpm').value=project.bpm.toFixed(1);changed();}};
  $('#cross-a').onclick=()=>fadeCrossfader(0);$('#cross-b').onclick=()=>fadeCrossfader(1);
  $('#layer-bank').onscroll=e=>{$('#column-viewport').scrollLeft=e.target.scrollLeft;};
  for(const b of $$('[data-inspector]'))b.onclick=()=>{inspectorTab=b.dataset.inspector;renderInspector();if(browserTab==='effects')renderBrowser();};
  for(const b of $$('[data-browser]'))b.onclick=()=>{browserTab=b.dataset.browser;renderBrowser();};
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
  window.addEventListener('beforeunload',()=>{if(dirty)autosave();for(const url of objectURLs)URL.revokeObjectURL(url);});
}

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

async function triggerColumn(index,{inputId,stillHeld=()=>true,held}={}){const items=project.layers.map(layer=>({layer,clip:clipList(layer)[index],request:id()})).filter(item=>item.clip&&!item.layer.ignoreColumn&&!item.clip.ignoreColumn&&!findClip(item.layer.activeClipId)?.clip.ignoreColumn);if(held)held.clips=items.map(item=>({layerId:item.layer.id,clipId:item.clip.id,inputId}));for(const item of items)triggerRequests.set(item.layer.id,item.request);const results=await Promise.allSettled(items.map(item=>engine.prepare(item.clip)));const time=now();for(let i=0;i<items.length;i++){const item=items[i];if(results[i].status==='rejected'){toast(`Cannot play ${item.clip.name}: ${results[i].reason.message}`,true);continue;}if(triggerRequests.get(item.layer.id)===item.request&&findClip(item.clip.id)&&(!transport.isPiano(item.clip)||stillHeld()))transport.trigger(item.layer.id,item.clip.id,time,{target:'own',inputId});}engine.audioContext?.resume().catch(()=>{});renderLayers();return items.map(item=>({layerId:item.layer.id,clipId:item.clip.id,inputId}));}
function addSource(source,layer=currentLayer(),index){
  const deckId=project.selectedDeckId;
  if(index===undefined)index=clipList(layer).findIndex(c=>!c);
  if(index<0)return toast('This layer is full. Add a deck or choose an empty slot.');
  const visible=visibleSlot(project,layer,deckId,index);
  if(visible.persistentFrom&&visible.persistentFrom!==deckId)return toast('This slot is covered by a persistent clip. Choose another slot or turn off persistence.');
  const clip=createClip('source',{name:source[0].toUpperCase()+source.slice(1),source});
  const slots=storedClipList(layer,deckId),previous=slots[index];
  if(previous){if(previous.id===layer.activeClipId)transport.stop(layer.id);engine.remove(previous.id);}
  slots[index]=clip;selectClip(layer,clip,index);changed();renderAll();
}
async function importFiles(layer=currentLayer(),index){
  if(desktop){try{const files=await desktop.importMedia();for(const file of files||[]){await placeMedia(file,layer,index);if(index!==undefined)index++;}}catch(e){toast(e.message,true);}return;}
  const input=document.createElement('input');input.type='file';input.accept='video/*,audio/*,image/*';input.multiple=true;input.onchange=()=>importFileList([...input.files],layer,index);input.click();
}
async function importFileList(files,layer,index){for(const file of files){let item;if(desktop?.getPathForFile){const path=desktop.getPathForFile(file);[item]=await desktop.importPaths([path]);}else{const url=URL.createObjectURL(file);objectURLs.add(url);item={name:file.name,url,path:'',kind:file.type.startsWith('audio/')?'audio':file.type.startsWith('image/')?'image':kindFor(file.name)};}await placeMedia(item,layer,index);if(index!==undefined)index++;}}
function kindFor(name){return /\.(png|jpe?g|gif|bmp|webp|avif|svg)$/i.test(name)?'image':/\.(wav|mp3|ogg|flac|m4a|aac|aiff?)$/i.test(name)?'audio':'video';}
async function placeMedia(item,layer,index){
  if(item.error)return toast(`Cannot import ${item.name}: ${item.error}`,true);
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
    changed();renderAll();toast(`Imported ${clip.name}`);return clip;
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
  engine.resize(project.width,project.height);transport.tick(now());
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
      capturedEngine=currentPreview.engine;
    }else if(kind==='output'){
      const time=now();engine.render(project,transport.tick(time),time);
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

async function openOutput(){if(!desktop){try{await $('#output-canvas').requestFullscreen();}catch(e){toast(e.message,true);}return;}if(outputOpen){await desktop.closeOutput();outputOpen=false;$('#output').classList.remove('active');return;}const displays=await desktop.getDisplays();const body=`<p>Choose a display for fullscreen output. Escape closes the output.</p><div class="select-field"><label>Display</label><select id="display-choice">${displays.map(d=>`<option value="${d.id}">${esc(d.label)} · ${d.width} × ${d.height}</option>`).join('')}</select></div>`;const dialog=showDialog('Output display',body,[['Cancel','cancel'],['Open output','open']]);dialog.addEventListener('close',async()=>{if(dialog.returnValue==='open'){await desktop.openOutput(Number($('#display-choice',dialog).value));outputOpen=true;$('#output').classList.add('active');}});}

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
function togglePreview(){
  if(preview)return stopPreview();const clip=currentClip();if(!clip)return toast('Select a clip to preview.');startPreview(clip);
}

function frame(timestamp){
  const t=timestamp/1000;
  try{const frames=transport.tick(t);engine.render(project,frames,t);if(preview){preview.project.bpm=project.bpm;preview.project.width=project.width;preview.project.height=project.height;preview.engine.render(preview.project,preview.transport.tick(t).map(f=>({...f,clip:{...f.clip,opacity:1,volume:0}})),t);}
    const active=project.layers.map(l=>l.activeClipId).join(',');if(active!==lastActive)renderLayers();
    for(const f of frames){
      const layerTimeline=layerPlayheads.get(f.layer.id);
      if(layerTimeline&&document.activeElement!==layerTimeline)layerTimeline.value=f.position;
      const progress=clipPlayheads.get(f.clip.id);
      if(progress)progress.style.transform=`scaleX(${Math.max(0,Math.min(1,f.position))})`;
      if(f.clip.id===selectedClipId&&f.layer.activeClipId===f.clip.id){
        if(inspectorPlayhead&&document.activeElement!==inspectorPlayhead)inspectorPlayhead.value=f.position;
        if(inspectorTime)inspectorTime.textContent=formatTime(f.time);
      }
    }
    paintFrames++;if(t-lastPaint>.1){lastPaint=t;for(const layer of project.layers){const queued=transport.getState(layer.id)?.pendingClipId;for(const slot of queuedSlots.get(layer.id)||[])slot.classList.toggle('queued',slot.dataset.clip===queued);}const beat=transport.beat??t*project.bpm/60;$('#beat-status').textContent=`BEAT ${Math.floor(beat/4)%999+1}.${Math.floor(beat%4)+1}`;if(recorder?.state==='recording')$('#record').textContent='■ '+formatTime(t-recordingStarted);}
    if(t-paintStart>1){$('#frame-count').textContent=`${Math.round(paintFrames/(t-paintStart))} FPS`;paintFrames=0;paintStart=t;const stats=engine.getStats?.();if(stats?.audioRms!==undefined)$('#audio-meter').textContent=stats.audioRms>0?Math.round(20*Math.log10(stats.audioRms))+' dB':'silent';$('#memory-status').textContent=stats?.mediaCount!==undefined?`${stats.mediaCount} media loaded`:'';}
    if(outputOpen&&!sendingFrame&&t-lastOutputFrame>1/30){sendingFrame=true;lastOutputFrame=t;$('#output-canvas').toBlob(async blob=>{try{if(blob)await desktop.sendOutputFrame(await blob.arrayBuffer());}finally{sendingFrame=false;}},'image/jpeg',.9);}
  }catch(e){if(!frame.lastError||t-frame.lastError>5){frame.lastError=t;toast(`Render error: ${e.message}`,true);}}
  requestAnimationFrame(frame);
}
function formatTime(seconds){return `${String(Math.floor(seconds/60)).padStart(2,'0')}:${(seconds%60).toFixed(2).padStart(5,'0')}`;}
let fadeToken=0;function fadeCrossfader(to){const token=++fadeToken,start=now(),from=project.crossfader;function step(){if(token!==fadeToken)return;const a=Math.min(1,(now()-start)/2);project.crossfader=from+(to-from)*a;$('#crossfader').value=project.crossfader;if(a<1)requestAnimationFrame(step);else changed();}step();}

function keyDown(e){
  if(/INPUT|SELECT|TEXTAREA/.test(e.target.tagName)||$('dialog[open]'))return;
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

function keyUp(e){const held=heldKeys.get(e.code);if(held){releaseHeld(held);heldKeys.delete(e.code);}}
function undo(redo=false){const source=redo?redoStack:undoStack,destination=redo?undoStack:redoStack;if(!source.length)return;destination.push(snapshot());const data=source.pop();const oldUndo=undoStack,oldRedo=redoStack;loadProject(JSON.parse(data));undoStack=oldUndo;redoStack=oldRedo;lastHistory=data;changed(false);toast(redo?'Redo':'Undo');}
async function enableMidi(){try{midiAccess=await navigator.requestMIDIAccess();const bind=()=>{for(const input of midiAccess.inputs.values())input.onmidimessage=midiMessage;};bind();midiAccess.onstatechange=()=>{bind();if(browserTab==='controls')renderBrowser();};renderBrowser();toast('MIDI input enabled.');}catch(e){toast(`MIDI unavailable: ${e.message}`,true);}}
function midiMessage(event){const [status,number,value]=event.data,type=(status&0xf0)===0xb0?'cc':(status&0xf0)===0x90&&value>0?'note':null;if(!type)return;const channel=status&15;if(learning){if(project.mappings.length>=LIMITS.mappings)return toast('Mapping limit reached.');project.mappings.push({type,channel,number,target:learning});learning=null;changed();renderBrowser();toast('MIDI control assigned.');return;}for(const map of project.mappings)if(map.type===type&&map.channel===channel&&map.number===number)controlTarget(map.target,value/127);}
function controlTarget(target,value){if(target.startsWith('column:')){if(value>0)triggerColumn(+target.split(':')[1]);}else if(target.startsWith('layer:')){const [,layerId,property]=target.split(':');const layer=project.layers.find(l=>l.id===layerId);if(layer&&['opacity','volume'].includes(property))layer[property]=value;}else if(['crossfader','masterOpacity','masterVolume'].includes(target))project[target]=value;syncGlobals();}
let controlRefresh;
function applyControl(message){
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
function help(){showDialog('Prism Live performance controls',`<div class="help-grid"><span><kbd>F1</kbd> to <kbd>F3</kbd></span><span>Select layer 1 to 3</span><span><kbd>1</kbd> to <kbd>0</kbd></span><span>Trigger clip in the selected layer</span><span><kbd>Shift + 1</kbd> to <kbd>0</kbd></span><span>Trigger a whole column</span><span><kbd>Q W E R T Y</kbd></span><span>Jump to cue; Shift to set cue</span><span><kbd>Z X C V B N</kbd></span><span>BeatLoopr off / 4 / 2 / 1 / 1/2 / 1/4</span><span><kbd>, . /</kbd></span><span>Reverse / forward / pause clip</span><span><kbd>I</kbd> / <kbd>O</kbd></span><span>Set clip in / out point</span><span><kbd>Left</kbd> / <kbd>Right</kbd></span><span>Trigger adjacent clip; Shift to select</span><span><kbd>Space</kbd></span><span>Pause / resume composition</span><span><kbd>Ctrl S</kbd> / <kbd>Ctrl O</kbd></span><span>Save / open composition</span><span><kbd>Ctrl Z</kbd> / <kbd>Ctrl Y</kbd></span><span>Undo / redo edits</span><span><kbd>Ctrl C / X / V</kbd></span><span>Copy / cut / paste selected clips</span><span>Right-click a clip</span><span>Select without triggering</span><span>Shift-click a clip</span><span>Select a range without triggering</span></div><p style="margin-top:18px;color:#9daabd">Deck changes preserve active playback. Layer order runs from bottom to top. Effects run on the clip, then layer, then composition. Recovery is saved automatically after edits.</p>`,[['Close','close']]);}


// Read-only diagnostics for automated runtime checks and support.
window.prismDiagnostics=()=>{
  const frames=transport.tick(now());
  return {project:serializeProject(project),preferences:{...preferences},
    frames:frames.map(frame=>({clipId:frame.clip.id,layerId:frame.layer.id,sourceLayerId:frame.sourceLayerId,voiceId:frame.voiceId,inputId:transport.getState(frame.layer.id)?.inputId,direction:frame.direction,position:frame.position,time:frame.time,weight:frame.weight})),
    voices:frames.map(frame=>{const voiceId=frame.sourceLayerId!==frame.layer.id?frame.voiceId:undefined;const media=engine.getMedia(frame.clip.id,voiceId),audio=engine.getAudio(frame.clip.id,voiceId);return {clipId:frame.clip.id,layerId:frame.layer.id,voiceId:frame.voiceId,mediaTime:media?.currentTime??null,audioTime:audio?.currentTime??null,mediaPaused:media?.paused??null,audioPaused:audio?.paused??null};}),
    stats:engine?.getStats?.(),recording:recorder?.state||'inactive'};
};
