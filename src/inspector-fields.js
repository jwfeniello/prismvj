import { BLEND_MODES, TRANSITION_IDS } from './blends.js';
import { DASHBOARD_PARAMETERS } from './dashboard.js';

const escape = value => String(value ?? '').replace(/[&<>"']/g, character => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[character]));
const valueOf = value => Number.isFinite(Number(value)) ? Number(value) : 0;

export function blendOptions(selected, transitions = false) {
  const modes = BLEND_MODES.filter(mode => mode.supported && (!transitions || TRANSITION_IDS.includes(mode.id)));
  return (transitions ? [{id:'random',label:'Random'}, ...modes] : modes)
    .map(mode => `<option value="${mode.id}" ${selected===mode.id?'selected':''}>${escape(mode.label)}</option>`).join('');
}

export function numericField(label, key, value, minimum, maximum, step = '.01', { pixels = false, disabled = false } = {}) {
  const attributes = `${pixels?'data-unit="pixels"':''} ${disabled?'disabled':''} min="${minimum}" max="${maximum}" step="${step}"`;
  const dashboardSupported=Object.values(DASHBOARD_PARAMETERS).some(parameters=>parameters.some(parameter=>parameter[0]===key));
  return `<div class="field"><label for="prop-${key}" title="Right-click to reset">${dashboardSupported?`<span class="parameter-drag" data-dashboard-source="${key}" draggable="true" title="Drag ${escape(label)} to a Dashboard dial">⠿</span>`:''}${escape(label)}</label><input id="prop-${key}" data-prop="${key}" type="range" value="${valueOf(value)}" ${attributes} title="Double-click or right-click to reset"><input class="number-value" data-number="${key}" type="text" inputmode="decimal" autocomplete="off" spellcheck="false" title="Type a value or math like 1920/3; ↑/↓ nudge, Shift ×10" value="${valueOf(value).toFixed(step==='1'?0:2)}" ${attributes} aria-label="${escape(label)} value"></div>`;
}

export function transformFields(target, project, scope) {
  let html = '<div class="section transform-fields"><h3>Transform</h3>';
  if (scope==='clip'||scope==='layer') {
    for (const [key, label, native] of [['width','Width',target.nativeWidth||project.width],['height','Height',target.nativeHeight||project.height]]) {
      const enabled = scope==='layer' ? target[key+'Enabled'] : target[key]!==null && target[key]!==undefined;
      html += `<label class="dimension-toggle"><input data-dimension="${key}" type="checkbox" ${enabled?'checked':''}> ${label} override <small>pixels</small></label>`;
      html += numericField(label,key,target[key]??native,0,8192,'1',{disabled:!enabled});
    }
  }
  html += numericField('Scale','scale',target.scale,0,10);
  if (scope!=='composition') {
    html += numericField('Position X (px)','x',target.x*project.width,-4096,4096,'1',{pixels:true});
    html += numericField('Position Y (px)','y',target.y*project.height,-4096,4096,'1',{pixels:true});
  }
  html += numericField('Rotate X','rotationX',target.rotationX,-180,180,'1');
  html += numericField('Rotate Y','rotationY',target.rotationY,-180,180,'1');
  html += numericField('Rotate Z','rotation',target.rotation,-180,180,'1');
  if (scope!=='composition') {
    for (const [key,label] of [['anchorX','Anchor X'],['anchorY','Anchor Y'],['anchorZ','Anchor Z']]) html += numericField(label,key,target[key],-4096,4096,'1');
  }
  return html+'</div>';
}

export function componentFields(clip) {
  return `<div class="component-channels" role="group" aria-label="Video channels">${[['red','R'],['green','G'],['blue','B'],['alpha','Alpha']].map(([key,label])=>`<label><input data-channel="${key}" type="checkbox" ${clip[key]!==false?'checked':''} ${key==='alpha'&&!clip.hasAlpha?'disabled':''}> ${label}</label>`).join('')}<small>${clip.hasAlpha?'Transparency detected':'No detected alpha channel'}</small></div>`;
}

export function compositionSettings(project, range) {
  const presets=[[640,360],[1280,720],[1920,1080],[2560,1440],[3840,2160]];
  const custom=!presets.some(([width,height])=>width===project.width&&height===project.height);
  return `<div class="section"><h3>Composition settings</h3><label class="stacked-field" for="composition-description">Description<textarea id="composition-description" rows="2" maxlength="4096">${escape(project.description)}</textarea></label><div class="select-field"><label for="composition-size">Resolution preset</label><select id="composition-size">${custom?`<option value="${project.width},${project.height}" selected>Custom</option>`:''}${presets.map(([width,height])=>`<option value="${width},${height}" ${project.width===width&&project.height===height?'selected':''}>${width} × ${height}</option>`).join('')}</select></div><div class="resolution-inputs"><label>Width<input id="composition-width" type="number" min="64" max="8192" step="1" value="${project.width}"></label><label>Height<input id="composition-height" type="number" min="64" max="8192" step="1" value="${project.height}"></label><button id="apply-composition-size">Apply size</button></div>${range('Video','masterOpacity',project.masterOpacity,0,1)}${range('Audio','masterVolume',project.masterVolume,0,4)}${range('Pan','pan',project.pan,-1,1)}${range('Crossfader','crossfader',project.crossfader,0,1)}<div class="select-field"><label for="prop-crossfaderBlend">Bus blend</label><select id="prop-crossfaderBlend" data-prop="crossfaderBlend">${blendOptions(project.crossfaderBlend||'normal')}</select></div><div class="select-field"><label for="prop-crossfaderCurve" title="Overlap keeps both buses at full strength in the middle; Linear is a classic mix">Curve</label><select id="prop-crossfaderCurve" data-prop="crossfaderCurve">${[['overlap','Overlap'],['linear','Linear'],['smooth','Smooth'],['cut','Cut']].map(([value,label])=>`<option value="${value}" ${(project.crossfaderCurve||'overlap')===value?'selected':''}>${label}</option>`).join('')}</select></div><div class="select-field"><label for="prop-crossfaderBehaviour" title="What the A and B buttons do">Behaviour</label><select id="prop-crossfaderBehaviour" data-prop="crossfaderBehaviour">${[['fade','Fade (4 beats)'],['jump','Jump'],['jump-return','Jump & Return'],['cut','Cut (hold)']].map(([value,label])=>`<option value="${value}" ${(project.crossfaderBehaviour||'fade')===value?'selected':''}>${label}</option>`).join('')}</select></div><div class="select-field"><label for="prop-triggerStyle">Default trigger style</label><select id="prop-triggerStyle" data-prop="triggerStyle">${['normal','piano'].map(value=>`<option ${project.triggerStyle===value?'selected':''}>${value}</option>`).join('')}</select></div><div class="select-field"><label for="prop-clipTarget">Default clip target</label><select id="prop-clipTarget" data-prop="clipTarget">${['own','selected','free'].map(value=>`<option ${project.clipTarget===value?'selected':''}>${value}</option>`).join('')}</select></div><button id="save-as">Save composition as…</button></div>`;
}
