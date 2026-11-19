// Self-contained read-only controller, embedded by render-review.
export function initializeVersionDiff(helpers, hooks) {
  const doc = document, bar = doc.querySelector('#version-diff-bar'), panel = doc.querySelector('#version-diff-panel');
  if (!bar || !panel) return;
  let sequence = 0, controller, diff = null, pair = null, selectedKey = null, tab = 'all', text = '', page = 0;
  let open = false, enabled = true, only = false, selectedState = null, opener = null;
  const size = 20, kindLabels = {added:'＋ 新增',changed:'~ 修改',removed:'− 移除'};
  const collectionLabels = {nodes:'卡片',edges:'关系',intentClaims:'意图',evidence:'证据',roadmapItems:'规划',featureCheckpoints:'续接',decisions:'决定',proposals:'提案',checks:'检查',reviews:'评审',mapUpdates:'维护',conversationCaptures:'会话',baselines:'基线'};
  function el(tag, value, className) { const node=doc.createElement(tag); if(value !== undefined) node.textContent=value; if(className) node.className=className; return node; }
  function button(label, fn, attrs = {}) { const b=el('button',label); b.type='button'; for(const [key,value] of Object.entries(attrs)) b.setAttribute(key,value); b.addEventListener('click',fn); return b; }
  function format(value, present) { return !present ? '（不存在）' : typeof value === 'string' ? value : JSON.stringify(value,null,2); }
  function activate(row, locate = true) {
    if (!row || hooks.canOpen?.() === false) return false;
    if(!open)opener=doc.activeElement;
    selectedKey=row.key; page=Math.max(0,Math.floor(filtered().findIndex(item=>item.key===row.key)/size)); open=true;
    renderPanel();
    if (locate && row.nodeIds.length) hooks.locate(row.nodeIds);
    panel.querySelector('h2')?.focus({preventScroll:true});
    return true;
  }
  function renderPanel() {
    if(open){hooks.openPanel();panel.hidden=false;}
    summary?.setAttribute('aria-expanded',String(open));
    const focused=panel.contains(doc.activeElement)?{id:doc.activeElement.id,start:doc.activeElement.selectionStart,end:doc.activeElement.selectionEnd}:null;
    const active = diff?.rows.find((row)=>row.key===selectedKey);
    panel.replaceChildren();
    const heading=el('div',undefined,'history-panel-head');
    const title=el('h2',diff ? `版本差异 · v${diff.beforeVersion} → v${diff.afterVersion}` : '版本差异');title.tabIndex=-1;
    heading.append(title,button('关闭对比',()=>close(true)));
    panel.append(heading,el('p','只读对比 · 不确认、不保存、不恢复版本；当前评审草稿保持原样。','muted'));
    if (!diff) { panel.append(el('p','差异不可用，请重新选点。'));if(focused)title.focus({preventScroll:true});return; }
    if (diff.gap) panel.append(el('p','版本间存在缺口，仅展示两端净变化；无法还原中间增删过程。','notice'));
    const controls=el('div',undefined,'version-diff-controls');
    const label=el('label','搜索变化'); const input=el('input'); input.type='search'; input.value=text; input.id='version-diff-search';
    input.addEventListener('input',()=>{text=input.value;page=0;renderList();}); label.append(input);
    const filterLabel=el('label','变化类型'); const select=el('select'); select.id='version-diff-filter';
    for(const [value,title] of [['all','全部'],['added','新增'],['changed','修改'],['removed','移除'],...Object.entries(collectionLabels)]) {const option=el('option',title);option.value=value;select.append(option);}
    select.value=tab; select.addEventListener('change',()=>{tab=select.value;page=0;renderList();}); filterLabel.append(select);
    controls.append(label,filterLabel); panel.append(controls,el('div',undefined,'version-diff-list'),el('div',undefined,'version-diff-detail'));
    renderList();
    if(focused){const target=focused.id?panel.querySelector('#'+focused.id):title;target?.focus({preventScroll:true});if(target===input&&focused.start!==null)target.setSelectionRange(focused.start,focused.end);}
    const detail=panel.querySelector('.version-diff-detail');
    if (!active) {detail.append(el('p',diff.rows.length ? '选择一项查看前后内容。' : '两端没有可展示的记录内容变化。','muted'));return;}
    detail.append(el('h3',kindLabels[active.kind]+' · '+active.collectionLabel+' · '+active.title));
    if (active.collection === 'nodes' && active.kind === 'changed') detail.append(el('p','只列实际变化字段；状态停止、替代不是节点删除。','muted'));
    if (active.nodeIds.length) detail.append(button('定位相关卡片',()=>hooks.locate(active.nodeIds)));
    const inspectId=active.nodeIds.find(id=>selectedState?.nodes.some(node=>node.id===id));
    if(inspectId)detail.append(button('查看所选版本卡片',()=>{close();hooks.inspect?.(inspectId);}));
    for(const field of active.fields) {
      const section=el('section',undefined,'version-diff-field');section.append(el('h4',field.label));
      const columns=el('div',undefined,'version-diff-values');
      for(const [side,version] of [['before',diff.beforeVersion],['after',diff.afterVersion]]) {
        const part=el('div',undefined,'version-diff-'+side);part.append(el('strong','v'+version),el('pre',format(field[side],field[side+'Present'])));columns.append(part);
      }
      section.append(columns);detail.append(section);
    }
  }
  function filtered() { const query=text.trim().toLocaleLowerCase(); return (diff?.rows || []).filter(row=>(tab==='all'||row.kind===tab||row.collection===tab)&&(!query||`${row.title} ${row.id} ${row.collectionLabel} ${row.fields.map(f=>f.label).join(' ')}`.toLocaleLowerCase().includes(query))); }
  function renderList() {
    const host=panel.querySelector('.version-diff-list');if(!host)return;
    const rows=filtered(), pages=Math.max(1,Math.ceil(rows.length/size));page=Math.min(page,pages-1);host.replaceChildren();
    host.append(el('p',`${rows.length} 项变化 · ${page+1}/${pages} 页`,'muted'));
    for(const row of rows.slice(page*size,(page+1)*size)) {
      const b=button(`${kindLabels[row.kind]} · ${row.collectionLabel} · ${row.title}`,()=>activate(row),{'data-diff-key':row.key,'aria-pressed':String(row.key===selectedKey)});
      b.className='version-diff-item';b.dataset.kind=row.kind;host.append(b);
    }
    if(!rows.length)host.append(el('p','没有符合筛选的变化。','muted'));
    const prev=button('上一页',()=>{page--;renderList();}),next=button('下一页',()=>{page++;renderList();});prev.disabled=page===0;next.disabled=page>=pages-1;host.append(prev,next);
  }
  function close(restoreFocus=false) {const wasOpen=open;open=false;panel.hidden=true;summary.setAttribute('aria-expanded','false');if(wasOpen)hooks.closePanel();if(wasOpen&&restoreFocus)(opener?.isConnected&&!opener.closest('[hidden]')?opener:summary).focus({preventScroll:true});}
  function step(direction) {const rows=filtered();if(!rows.length)return;let index=rows.findIndex(row=>row.key===selectedKey);index=index<0?(direction>0?0:rows.length-1):(index+direction+rows.length)%rows.length;activate(rows[index]);}
  const toggle=el('input');toggle.type='checkbox';toggle.checked=true;toggle.id='version-diff-enabled';
  const toggleLabel=el('label','图上标注');toggleLabel.prepend(toggle);
  const summary=button('读取差异…',()=>{if(hooks.canOpen?.()===false)return;if(!open)opener=doc.activeElement;open=true;renderPanel();panel.querySelector('h2')?.focus({preventScroll:true});},{id:'version-diff-summary','aria-controls':'version-diff-panel'});
  const previous=button('上一处',()=>step(-1),{id:'version-diff-previous'}),next=button('下一处',()=>step(1),{id:'version-diff-next'});
  const onlyToggle=el('input');onlyToggle.type='checkbox';onlyToggle.id='version-diff-only';const onlyLabel=el('label','仅看变化');onlyLabel.prepend(onlyToggle);
  bar.append(toggleLabel,summary,previous,next,onlyLabel);
  function renderBar(message) {
    bar.hidden=false;bar.dataset.status=diff?'ready':message==='正在读取版本差异…'?'loading':'unavailable';
    summary.textContent=message || `v${diff.beforeVersion} → v${diff.afterVersion}：＋${diff.collections.nodes.added} ~${diff.collections.nodes.changed} −${diff.collections.nodes.removed} 卡片 · 关系 ${diff.rows.filter(r=>r.collection==='edges').length} · 查看全部 ${diff.rows.length} 项${diff.gap?'（有缺口）':''}`;
    summary.disabled=!diff;summary.setAttribute('aria-expanded',String(open));previous.disabled=next.disabled=!diff?.rows.length;onlyToggle.disabled=!diff;
  }
  function paint() {
    if(!diff || !enabled) {hooks.paint(null);return;}
    const graph=hooks.graphData(selectedState);
    const alternate=hooks.graphData(pair.before===selectedState?pair.after:pair.before);
    const ids=new Set(graph.nodes.map(n=>n.id));
    for(const node of alternate.nodes) if(!ids.has(node.id))graph.nodes.push({...node,diffGhost:true});
    for(const node of graph.nodes)if(node.diffGhost)node.diffGhostLabel=selectedState===pair.after?'仅旧版存在':'仅新版存在';
    for(const node of graph.nodes) node.diff=diff.nodeChanges[node.id] || null;
    const edgeIds=new Set(graph.edges.map(e=>e.id));
    const edgeRows=new Map(diff.rows.filter(r=>r.collection==='edges').map(r=>[r.id,r]));
    for(const edge of alternate.edges){
      if(!edgeIds.has(edge.id))graph.edges.push({...edge,diffGhost:true});
      else {
        const selected=graph.edges.find(item=>item.id===edge.id);
        if(selected.from!==edge.from || selected.to!==edge.to || selected.kind!==edge.kind){
          let id='comparison:'+edge.id;while(edgeIds.has(id))id='comparison:'+id;edgeIds.add(id);
          graph.edges.push({...edge,id,diffRecordId:edge.id,diffGhost:true,label:'对端关系 · '+edge.label});
        }
      }
    }
    for(const edge of graph.edges)edge.diff=edgeRows.get(edge.diffRecordId || edge.id)?.kind || null;
    graph.comparison={only,changedNodeIds:Object.keys(diff.nodeChanges)};
    hooks.paint(graph);
  }
  toggle.addEventListener('change',()=>{enabled=toggle.checked;paint();});onlyToggle.addEventListener('change',()=>{only=onlyToggle.checked;paint();});
  async function update(sample, neighbor, result) {
    const token=++sequence;controller?.abort();controller=new AbortController();diff=null;pair=null;selectedState=result?.state || hooks.current().state;
    hooks.paint(null);renderBar(neighbor?'正在读取版本差异…':'没有可核验的相邻版本');
    if(open)renderPanel();
    if(!neighbor || !selectedState)return;
    try {
      const other=neighbor.source==='current'?hooks.current():await hooks.loadSnapshot(neighbor,controller.signal);
      if(token!==sequence)return;
      if(other.state?.stateVersion!==neighbor.stateVersion || other.fileDigest!==neighbor.digest)throw new Error('对比端点已变化');
      diff=helpers.compareSnapshots(selectedState,other.state);
      pair=selectedState.stateVersion<other.state.stateVersion?{before:selectedState,after:other.state}:{before:other.state,after:selectedState};
      selectedKey=diff.rows.some(row=>row.key===selectedKey)?selectedKey:null;
      paint();renderBar();if(open)renderPanel();
    } catch(error) {if(token!==sequence)return;diff=null;hooks.paint(null);renderBar('差异不可核验，请刷新或重新选点');if(open)renderPanel();}
  }
  renderBar('正在读取版本差异…');
  return {update,close,isOpen:()=>open,selectNode(id) {const keys=diff?.nodeChanges[id]?.rowKeys;if(!enabled||!keys?.length)return false;return activate(diff.rows.find(row=>row.key===keys[0]),false);},
    unavailable() {sequence++;controller?.abort();diff=null;pair=null;hooks.paint(null);renderBar('所选快照不可用，未展示差异');if(open)renderPanel();}};
}
