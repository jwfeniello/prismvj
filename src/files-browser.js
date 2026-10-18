const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));

// Browser state survives tab switches. Native paths are converted to authorized
// media URLs only when a file is imported or previewed.
export class FilesBrowser {
  constructor({desktop, onImport, onPreview, onRelink, onError}) {
    Object.assign(this, {desktop,onImport,onPreview,onRelink,onError});
    this.path=''; this.parent=null; this.entries=[]; this.bookmarks=['',''];
    this.search=''; this.thumbnails=false; this.thumbnailChoice=false; this.request=0; this.previewRequest=0;
    this.urls=new Map(); this.thumbnailFailures=new Set(); this.thumbnailPending=new Set();
    this.loading=false; this.container=null; this.truncated=false; this.initialized=false;
  }
  render(container) {
    this.container=container;
    container.dataset.fileBrowser='true';
    if(!this.desktop?.browseRoots) {
      container.innerHTML='<div class="section"><button id="import-media" class="primary" style="width:100%">+ Import media</button><p class="browser-note">Drop video, images, or audio into a clip slot. The folder browser is available in the Windows app.</p></div>';
      container.querySelector('#import-media').onclick=()=>this.onImport();
      return;
    }
    this.paint();
    if(!this.initialized&&!this.loading)this.navigate(this.path);
  }
  isMounted(){return this.container?.isConnected&&this.container.dataset.fileBrowser==='true';}
  async navigate(path) {
    const request=++this.request;this.loading=true;this.paint();
    try {
      const result=path?await this.desktop.browseDirectory(path):{path:'',parent:null,entries:await this.desktop.browseRoots()};
      if(request!==this.request)return;
      this.path=result.path;this.parent=result.parent;this.entries=result.entries;this.truncated=Boolean(result.truncated);this.initialized=true;
      if(!this.thumbnailChoice&&result.entries.some(entry=>entry.kind==='video'&&/\.mov$/i.test(entry.name)))this.thumbnails=true;
      this.search='';
    } catch(error){if(request===this.request)this.onError(error.message);}
    finally{if(request===this.request){this.loading=false;this.paint();}}
  }
  paint() {
    if(!this.isMounted())return;
    const active=this.container.contains(document.activeElement)?document.activeElement:null;
    const focusId=active?.id,selection=active?.selectionStart;
    const scroll=this.container.querySelector('.file-entries')?.scrollTop||0;
    const entries=this.entries.filter(entry=>entry.name.toLocaleLowerCase().includes(this.search.toLocaleLowerCase()));
    this.container.innerHTML=`<div class="section file-tools"><div class="row"><button id="import-media" class="primary grow">+ Import media</button><button id="choose-folder" title="Choose folder">…</button></div><div class="row" style="margin-top:8px"><button id="file-roots">Drives</button><button id="file-parent" ${!this.path?'disabled':''}>Up</button>${['A','B'].map((label,index)=>`<button data-bookmark="${index}" title="Click to open; Shift-click to store current folder">${label}</button>`).join('')}<label class="row"><input id="file-thumbnails" type="checkbox" ${this.thumbnails?'checked':''}>Thumbs</label></div><div class="file-path" title="${escape(this.path)}">${escape(this.path||'Computer')}</div><input id="file-search" type="text" placeholder="Find files in this folder" aria-label="Find files" value="${escape(this.search)}"><div class="row" style="margin-top:7px"><button id="relink-all" class="icon-btn">Reconnect missing files</button></div></div><div class="browser-note">Double-click to preview. Drag a file into a slot, or use + to import. Shift-drop audio onto video to pair them.</div><div class="file-entries">${this.loading?'<p class="empty">Reading folder…</p>':entries.map((entry,index)=>`<div class="file-entry" data-file-index="${index}" tabindex="0" draggable="${entry.kind!=='directory'}"><span class="file-kind">${entry.kind==='directory'?'DIR':escape(entry.kind.toUpperCase())}</span>${this.thumbnails&&this.urls.has(entry.path)?`<img class="file-thumb" src="${escape(this.urls.get(entry.path))}" alt="">`:''}<span class="file-name" title="${escape(entry.path)}">${escape(entry.name)}</span>${entry.kind!=='directory'?`<button data-import-file="${index}" class="icon-btn" title="Import ${escape(entry.name)}">+</button>`:'<span>›</span>'}</div>`).join('')||'<p class="empty">No matching media or folders.</p>'}</div>${this.truncated?'<p class="browser-note">This folder has more entries than can be displayed. Use a smaller folder to see the remaining files.</p>':''}`;
    this.container.querySelector('#import-media').onclick=()=>this.onImport();
    this.container.querySelector('#choose-folder').onclick=async()=>{const request=this.request;try{const path=await this.desktop.chooseMediaDirectory(this.path);if(path&&request===this.request&&this.isMounted())this.navigate(path);}catch(e){if(request===this.request&&this.isMounted())this.onError(e.message);}};
    this.container.querySelector('#file-roots').onclick=()=>this.navigate('');
    this.container.querySelector('#file-parent').onclick=()=>this.navigate(this.parent||'');
    this.container.querySelector('#relink-all').onclick=()=>this.onRelink();
    this.container.querySelector('#file-thumbnails').onchange=event=>{this.thumbnailChoice=true;this.thumbnails=event.target.checked;this.paint();};
    this.container.querySelector('#file-search').oninput=event=>{this.search=event.target.value;const position=event.target.selectionStart;this.paint();const input=this.container.querySelector('#file-search');input.focus();input.setSelectionRange(position,position);};
    for(const button of this.container.querySelectorAll('[data-bookmark]'))button.onclick=event=>{const index=Number(button.dataset.bookmark);if(event.shiftKey){this.bookmarks[index]=this.path;button.title=`Stored ${this.path||'Computer'}`;}else this.navigate(this.bookmarks[index]);};
    for(const element of this.container.querySelectorAll('[data-file-index]')) {
      const entry=entries[Number(element.dataset.fileIndex)];
      const open=()=>entry.kind==='directory'?this.navigate(entry.path):this.preview(entry);
      element.ondblclick=open;
      element.onkeydown=event=>{if(event.code==='Enter'){event.preventDefault();event.stopPropagation();open();}};
      element.ondragstart=event=>{if(entry.kind==='directory')return event.preventDefault();event.dataTransfer.setData('application/prism-path',entry.path);event.dataTransfer.effectAllowed='copy';};
      element.querySelector('[data-import-file]')?.addEventListener('click',event=>{event.stopPropagation();this.import(entry);});
      const thumbnail=element.querySelector('.file-thumb');
      if(thumbnail)thumbnail.onerror=()=>{this.thumbnailFailures.add(entry.path);this.urls.delete(entry.path);thumbnail.remove();};
    }
    this.container.querySelector('.file-entries').scrollTop=scroll;
    const focus=focusId?this.container.querySelector(`#${focusId}`):null;
    if(focus){focus.focus({preventScroll:true});if(typeof selection==='number'&&focus.type==='text')focus.setSelectionRange(selection,selection);}
    if(this.thumbnails&&!this.loading)this.loadThumbnails(entries);
  }
  async item(entry){const [item]=await this.desktop.importPaths([entry.path]);if(!item||item.error)throw new Error(item?.error||`Cannot import ${entry.name}.`);return item;}
  async import(entry){try{await this.onImport(await this.item(entry));}catch(e){this.onError(e.message);}}
  async preview(entry){const token=++this.previewRequest;try{const item=await this.item(entry);if(token===this.previewRequest&&this.isMounted())await this.onPreview(item);}catch(e){if(token===this.previewRequest&&this.isMounted())this.onError(e.message);}}
  async loadThumbnails(entries){
    const candidates=entries.filter(entry=>entry.kind==='image'||entry.kind==='video'&&/\.mov$/i.test(entry.name)).slice(0,256);
    const pending=candidates.filter(entry=>!this.urls.has(entry.path)&&!this.thumbnailFailures.has(entry.path)&&!this.thumbnailPending.has(entry.path)).slice(0,48);
    if(!pending.length)return;
    const request=this.request;
    for(const entry of pending)this.thumbnailPending.add(entry.path);
    try{
      const movies=pending.filter(entry=>entry.kind==='video');
      const images=pending.filter(entry=>entry.kind==='image');
      const [stillItems,movieItems]=await Promise.all([
        images.length?this.desktop.importPaths(images.map(entry=>entry.path)):[],
        movies.length&&this.desktop.mediaThumbnails?this.desktop.mediaThumbnails(movies.map(entry=>entry.path)):[],
      ]);
      const items=[...stillItems,...movieItems];
      for(let index=0;index<pending.length;index++){
        const entry=pending[index],item=items.find(item=>item.path===entry.path)||(!items[index]?.path?items[index]:null);
        if(item&&!item.error&&(item.thumbnailUrl||item.url))this.urls.set(entry.path,item.thumbnailUrl||item.url);
        else this.thumbnailFailures.add(entry.path);
      }
      if(this.urls.size>256){const keep=new Set(candidates.map(e=>e.path));for(const path of this.urls.keys()){if(this.urls.size<=256)break;if(!keep.has(path))this.urls.delete(path);}}
    }catch(error){for(const entry of pending)this.thumbnailFailures.add(entry.path);if(request===this.request&&this.isMounted())this.onError(error.message);}
    finally{
      for(const entry of pending)this.thumbnailPending.delete(entry.path);
      // paint reads the current folder. Cached results may belong to an older
      // request, but must never resurrect the Files tab after it was detached.
      if(this.isMounted()&&this.thumbnails)this.paint();
    }
  }
  detach(){if(this.container)this.container.dataset.fileBrowser='false';this.container=null;this.previewRequest++;this.request++;this.loading=false;}
}
