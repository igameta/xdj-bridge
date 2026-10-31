const $ = id => document.getElementById(id);
const stateLabels = { disconnected:'切断', observing:'機器を検出中', joining:'参加中', online:'受信中', degraded:'受信が途絶えています' };
const sessionStatusLabels = { disconnected:'未接続', observing:'検出中', joining:'参加中', online:'受信中', degraded:'受信停止' };
const modeLabels = { idle:'', demo:'', replay:'キャプチャ再生', passive:'受信のみ', 'virtual-device':'仮想参加', 'az-standalone':'AZスタンドアロン・試験', alphatheta:'Pro DJ Link' };
const playLabels = { playing:'再生中', looping:'ループ再生', cue_playing:'CUE再生', paused:'一時停止', cued:'CUE', stopped:'停止', ended:'終了', loading:'ロード中', no_track:'曲なし', unknown:'不明' };
const deckNodes = new Map();
const deckRevisions = new Map();
const discoveryRows = new Map();
const emptyState = $('decks').querySelector('.empty-state').cloneNode(true);
let snapshot;
let runtime;
let socket;
let reconnect;
let disposed = false;
let connectionDirty = false;
let oscDirty = false;
let notificationsDirty = false;
let connectionBusy = false;
let oscBusy = false;
let notificationsBusy = false;
let discoveryBusy = false;
let connectionRequestError = '';
let connectionRuntimeError = '';
let notificationsRequestError = '';
let notificationsRuntimeError = '';
let discoveryRequestError = '';
let discoveryRuntimeError = '';
let runtimeRequest;
let runtimeVersion = 0;
let lastRuntimeRefresh = -Infinity;
let lastSessionKey;
let interfaceKey;
let interfaceInteracting = false;
let diagnosticKey;
let renderTimer;
let lastRenderAt = -Infinity;
let reasonSessionId;
let lastConnectionMessage = '';

function text(tag, className, content) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (content !== undefined) el.textContent = String(content);
  return el;
}
function value(field) { return field?.value ?? null; }
function format(field, digits = 2) { const v = value(field); return typeof v === 'number' && Number.isFinite(v) ? v.toFixed(digits) : '—'; }
function duration(ms) {
  if (!Number.isFinite(ms)) return '—';
  const seconds = Math.max(0, ms) / 1000;
  return Math.floor(seconds / 60).toString().padStart(2,'0') + ':' + (seconds % 60).toFixed(1).padStart(4,'0');
}
function setText(node, content) {
  const next = String(content);
  if (node.textContent !== next) node.textContent = next;
}
function rememberSessionReason(session) {
  if (reasonSessionId !== session.id) { reasonSessionId = session.id; lastConnectionMessage = ''; }
  if (typeof session.reason === 'string' && session.reason.trim() && session.reason !== lastConnectionMessage) lastConnectionMessage = session.reason;
}
function renderSessionDetails(session) {
  rememberSessionReason(session);
  const state = Object.hasOwn(sessionStatusLabels,session.state) ? session.state : 'disconnected';
  const badge = $('session-status');
  setText(badge,sessionStatusLabels[state]);
  if (badge.dataset.state !== state) badge.dataset.state = state;
  setText($('session-detail-state'),sessionStatusLabels[state]);
  setText($('session-detail-interface'),session.interfaceId ?? '—');
  setText($('session-last-reason'),lastConnectionMessage || '記録はありません。');
}
function message(id, content) { setText($(id),content); if ($(id).hidden !== !content) $(id).hidden = !content; }
// Preserve existing nodes, focus, expanded details and scroll positions.
function reconcileChildren(parent, nodes) {
  const wanted = new Set(nodes);
  for (const child of [...parent.children]) if (!wanted.has(child)) child.remove();
  let cursor = parent.firstElementChild;
  for (const node of nodes) {
    if (node === cursor) cursor = cursor.nextElementSibling;
    else parent.insertBefore(node,cursor);
  }
}
function discoveryAge(ageMs) {
  if (typeof ageMs !== 'number' || !Number.isFinite(ageMs) || ageMs < 0) return '未確認';
  if (ageMs < 1000) return 'たった今';
  if (ageMs < 60000) return Math.floor(ageMs / 1000) + '秒前';
  if (ageMs < 3600000) return Math.floor(ageMs / 60000) + '分前';
  return Math.floor(ageMs / 3600000) + '時間前';
}
function renderDiscoveryDevices(devices, emptyMessage) {
  const nodes = devices.map(device => {
    let row = discoveryRows.get(device.id);
    if (!row) {
      row = text('article','discovery-device');
      const heading = text('div','discovery-device-heading');
      heading.append(text('strong','discovery-device-model'),text('span','discovery-device-state'));
      row.append(heading,text('p','discovery-device-address'),text('p','discovery-device-last-seen'),text('p','discovery-device-reason'));
      discoveryRows.set(device.id,row);
    }
    setText(row.querySelector('.discovery-device-model'),device.model);
    setText(row.querySelector('.discovery-device-address'),device.address + ' · 通信番号 ' + (device.number ?? '—'));
    const state = row.querySelector('.discovery-device-state');
    setText(state,device.stateLabel);
    if (state.dataset.state !== device.state) state.dataset.state = device.state;
    setText(row.querySelector('.discovery-device-last-seen'),'最終検出 ' + discoveryAge(device.ageMs) + ' · ' + device.interfaceLabel);
    const reason = row.querySelector('.discovery-device-reason'); setText(reason,device.reason ?? ''); if (reason.hidden !== !device.reason) reason.hidden = !device.reason;
    return row;
  });
  const container = $('discovery-devices');
  if (!nodes.length) {
    let empty = container.querySelector('.discovery-empty');
    if (!empty) { empty = text('p','discovery-empty'); reconcileChildren(container,[empty]); }
    setText(empty,emptyMessage);
  } else reconcileChildren(container,nodes);
  for (const key of discoveryRows.keys()) if (!devices.some(device => device.id === key)) discoveryRows.delete(key);
}
function renderDiscovery() {
  const discovery = runtime?.discovery;
  const devices = [...(discovery?.devices ?? [])].sort((a,b) => a.sourceIp.localeCompare(b.sourceIp,undefined,{numeric:true}) || a.wireDeviceId - b.wireDeviceId || a.id.localeCompare(b.id));
  const labels = { announced:'機器通知のみ', receiving:'状態受信中', unassigned:'LAN未確定' };
  renderDiscoveryDevices(devices.map(device => {
    const state = device.interfaceId == null ? 'unassigned' : device.status === 'announced' && device.lastStatusAt != null ? 'stale' : device.status;
    const label = state === 'stale' ? device.lastStatusAt != null ? '状態受信停止' : '通知が途絶' : labels[state] ?? '検出';
    return { id:device.id, model:device.model, address:device.sourceIp, number:device.wireDeviceId,
      state, stateLabel:label, ageMs:device.ageMs, reason:device.reason,
      interfaceLabel:device.interfaceId && device.interfaceEvidence !== 'unknown' ? device.interfaceId + (device.interfaceEvidence === 'capture' ? '（IF確認）' : '（IF推定）') : 'IF未確定' };
  }),
  discovery?.searching ? '機器通知を待っています。' : discovery?.attempted ? 'この探索時間内に機器通知を受信できませんでした。' : '探索結果はまだありません。');
  const scope = discovery?.interfaceName;
  const source = discovery?.source === 'session' ? '接続中の受信を確認' : '機器通知を受信';
  setText($('discovery-status'),discovery?.searching ? (scope ? scope + ' · ' : '') + source + '中…' : scope ? scope + ' · 検出 ' + devices.length + '件' : 'LANを選択して機器を探してください。');
  discoveryRuntimeError = typeof discovery?.error === 'string' ? discovery.error : '';
  renderDiscoveryError();
}
function renderDiscoveryError() {
  const errors = [...new Set([discoveryRequestError,discoveryRuntimeError].filter(Boolean))];
  message('discovery-error',errors.join(' / '));
}
function scheduleRender() {
  if (disposed || renderTimer !== undefined) return;
  renderTimer = setTimeout(() => {
    renderTimer = undefined; lastRenderAt = performance.now(); render();
  }, Math.max(0,50 - (performance.now() - lastRenderAt)));
}
const settingsDialog = $('settings-drawer');
const settingsButton = $('settings-button');
settingsButton.addEventListener('click',() => {
  if (settingsDialog.open) return;
  settingsDialog.showModal();
  settingsButton.setAttribute('aria-expanded','true');
  document.documentElement.classList.add('settings-open');
});
$('settings-close').addEventListener('click',() => settingsDialog.close());
settingsDialog.addEventListener('close',() => {
  settingsButton.setAttribute('aria-expanded','false');
  document.documentElement.classList.remove('settings-open');
  settingsButton.focus({ preventScroll:true });
  interfaceInteracting = false; flushInterfaces();
});
// Native dialog handles focus containment and Escape. Backdrop clicks target
// the dialog itself, so use its bounds to distinguish empty space inside it.
settingsDialog.addEventListener('click',event => {
  if (event.target !== settingsDialog) return;
  const bounds = settingsDialog.getBoundingClientRect();
  if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) settingsDialog.close();
});
function renderConnectionError() {
  const errors = [...new Set([connectionRequestError,connectionRuntimeError,connectionChoiceError()].filter(Boolean))];
  message('connection-error',errors.join(' / '));
}
function connectionChoiceError() {
  return $('method-select').value === 'az-standalone' && !['auto','xdj-az'].includes($('device-select').value) ? 'AZスタンドアロン（試験）は、機器を「自動検出」または「XDJ-AZ」にしてください。' : '';
}
function renderNotificationsError() {
  const errors = [...new Set([notificationsRequestError,notificationsRuntimeError].filter(Boolean))];
  message('notifications-error',errors.join(' / '));
}
async function requestJson(url, body) {
  const response = await fetch(url, body === undefined ? { cache:'no-store' } : { method:'POST', headers:{ 'Content-Type':'application/json' }, body:JSON.stringify(body) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? '設定を取得できませんでした。');
  return result;
}
function selectedMethod(connection) {
  if (connection.mode === 'az-standalone') return 'az-standalone';
  return connection.mode === 'passive' ? connection.backend === 'alphatheta' ? 'pcap' : 'passive' : 'virtual-device';
}
function updateInterfaces(interfaces, selected) {
  const select = $('interface-select');
  // Do not replace options or reset the native selection while it is in use.
  if (interfaceKey !== undefined && (interfaceInteracting || document.activeElement === select)) return;
  const groups = new Map();
  for (const iface of interfaces) {
    if (!groups.has(iface.name)) groups.set(iface.name,new Set());
    groups.get(iface.name).add(iface.address);
  }
  const desired = [{ value:'', label:'選択してください', disabled:false }];
  for (const name of [...groups.keys()].sort((a,b) => a.localeCompare(b,undefined,{numeric:true}))) {
    const addresses = [...groups.get(name)].sort((a,b) => a.localeCompare(b,undefined,{numeric:true}));
    desired.push({ value:name, label:name + ' · ' + addresses.join(', '), disabled:false });
  }
  if (selected && !groups.has(selected)) desired.push({ value:selected, label:selected + ' · 現在利用できません', disabled:true });
  const key = JSON.stringify(desired);
  if (key !== interfaceKey) {
    const previous = new Map([...select.options].map(option => [option.value,option]));
    const nodes = desired.map(item => {
      const option = previous.get(item.value) ?? document.createElement('option');
      if (option.value !== item.value) option.value = item.value;
      setText(option,item.label);
      if (option.disabled !== item.disabled) option.disabled = item.disabled;
      return option;
    });
    reconcileChildren(select,nodes); interfaceKey = key;
  }
  if (select.value !== selected) select.value = selected;
}
function flushInterfaces() {
  if (!runtime) return;
  const selected = connectionDirty ? $('interface-select').value : runtime.connection?.interfaceName ?? $('interface-select').value;
  updateInterfaces(runtime.interfaces ?? [],selected); updateControls();
}
// Native select popovers can move DOM focus to the enclosing dialog. Keep an
// interaction latch as well as activeElement so refreshes never close them.
$('interface-select').addEventListener('pointerdown',() => { interfaceInteracting = true; });
$('interface-select').addEventListener('keydown',event => {
  interfaceInteracting = !['Escape','Tab'].includes(event.key);
  if (!interfaceInteracting) setTimeout(flushInterfaces,0);
});
$('interface-select').addEventListener('change',() => {
  interfaceInteracting = false;
  // The form's bubbling change handler sets connectionDirty before flushing.
  setTimeout(flushInterfaces,0);
});
$('interface-select').addEventListener('blur',() => { if (!interfaceInteracting) flushInterfaces(); });
document.addEventListener('pointerdown',event => {
  if (!$('interface-select').contains(event.target) && interfaceInteracting) { interfaceInteracting = false; flushInterfaces(); }
},true);
function applyRuntime(next) {
  runtime = next;
  const connection = runtime.connection ?? {};
  // Runtime failures can arrive after a successful "connecting" response.
  // Clearing that remote failure must preserve a rejected form submission.
  connectionRuntimeError = typeof connection.error === 'string' ? connection.error : '';
  renderConnectionError();
  const interfaces = runtime.interfaces ?? [];
  const selected = connectionDirty ? $('interface-select').value : connection.interfaceName ?? $('interface-select').value ?? '';
  updateInterfaces(interfaces, selected);
  if (!connectionDirty) {
    const device = connection.profile ?? 'auto', method = selectedMethod(connection);
    if ($('device-select').value !== device) $('device-select').value = device;
    if ($('method-select').value !== method) $('method-select').value = method;
  }
  if (!oscDirty && runtime.osc) {
    if ($('osc-enabled').checked !== runtime.osc.enabled) $('osc-enabled').checked = runtime.osc.enabled;
    for (const [id,setting] of [['osc-host',runtime.osc.host],['osc-port',runtime.osc.port],['osc-rate',runtime.osc.maxHz],['osc-snapshot',runtime.osc.snapshotIntervalMs]]) {
      if ($(id).value !== String(setting)) $(id).value = String(setting);
    }
  }
  notificationsRuntimeError = typeof runtime.notifications?.error === 'string' ? runtime.notifications.error : '';
  renderNotificationsError();
  if (!notificationsDirty && runtime.notifications && $('notifications-enabled').checked !== runtime.notifications.enabled) $('notifications-enabled').checked = runtime.notifications.enabled;
  renderDiscovery();
  updateControls();
}
function updateControls() {
  const connection = runtime?.connection ?? {};
  const configured = Boolean(runtime);
  const selected = $('interface-select').value;
  const validInterface = Boolean(runtime?.interfaces?.some(iface => iface.name === selected));
  const connecting = Boolean(connection.connecting);
  for (const id of ['device-select','interface-select','method-select']) if ($(id).disabled !== (!configured || connectionBusy)) $(id).disabled = !configured || connectionBusy;
  const connectDisabled = !configured || connectionBusy || connecting || !validInterface || Boolean(connectionChoiceError());
  if ($('connect-button').disabled !== connectDisabled) $('connect-button').disabled = connectDisabled;
  setText($('connect-button'),connectionBusy || connecting ? '接続中…' : connection.connected ? '接続し直す' : '接続');
  const disconnectDisabled = !configured || connectionBusy || !(connection.connected || connecting);
  if ($('disconnect-button').disabled !== disconnectDisabled) $('disconnect-button').disabled = disconnectDisabled;
  const activeState = snapshot && snapshot.session.mode === connection.mode ? stateLabels[snapshot.session.state] : undefined;
  const status = connecting ? '接続中…' : connection.connected ? connection.mode === 'demo' ? 'デモデータ' : connection.mode === 'replay' ? 'キャプチャ再生中' : activeState ?? '接続中' : '未接続';
  setText($('connection-status'),configured ? status : '設定を読み込み中');
  $('connection-status').classList.toggle('active',Boolean(connection.connected || connecting));
  const method = $('method-select').value;
  setText($('connection-hint'),method === 'az-standalone' ? '本体PRO DJ LINK ModeはOFFのまま。PC型参加を試します。実機未検証。' : connectionDirty ? '変更は「接続」を押すと反映されます。' : connection.mode === 'demo' ? '接続するとデモから実機の受信に切り替わります。' : method === 'pcap' ? '既に流れている通信をpcapで受信します。' : method === 'passive' ? '機器への参加通知を送らず、届く状態を受信します。' : '接続先のネットワークへ参加して状態を受信します。');
  renderConnectionError();
  const discoveryDisabled = !runtime?.discovery || !validInterface || discoveryBusy || runtime.discovery.searching || connectionBusy || oscBusy || notificationsBusy;
  if ($('discovery-button').disabled !== discoveryDisabled) $('discovery-button').disabled = discoveryDisabled;
  setText($('discovery-button'),discoveryBusy || runtime?.discovery?.searching ? '探索中…' : '機器を探す');
  const expectedModel = { 'xdj-rx3':'XDJ-RX3', 'xdj-az':'XDJ-AZ' }[$('device-select').value];
  const differentModel = expectedModel && runtime?.discovery?.devices?.some(device => /^(CDJ|XDJ)/.test(device.model) && device.model !== expectedModel);
  message('discovery-profile-hint',differentModel ? '異なる機種を検出しました。機種の選択は「自動検出」を推奨します。' : '');
  const emptyDiscovery = runtime?.discovery?.attempted && !runtime.discovery.searching && !runtime.discovery.error && runtime.discovery.devices.length === 0;
  message('discovery-help',emptyDiscovery ? method === 'az-standalone' ? 'PCのIP/サブネット、WindowsではNode.jsの受信許可を確認してください。' : 'AZのPRO DJ LINK設定、PCのIP/サブネット、WindowsではNode.jsの受信許可を確認してください。' : '');
  message('discovery-az-note',emptyDiscovery && method !== 'az-standalone' && $('device-select').value === 'xdj-az' ? 'AZでPRO DJ LINKを有効にすると、本体のDeck 3/4は使えません。' : '');
  for (const id of ['osc-enabled','osc-host','osc-port','osc-rate','osc-snapshot']) if ($(id).disabled !== (!configured || oscBusy)) $(id).disabled = !configured || oscBusy;
  const oscDisabled = !configured || oscBusy || !oscDirty;
  if ($('osc-apply').disabled !== oscDisabled) $('osc-apply').disabled = oscDisabled;
  setText($('osc-apply'),oscBusy ? '適用中…' : '適用');
  if ($('osc-unsaved').hidden !== !oscDirty) $('osc-unsaved').hidden = !oscDirty;
  setText($('osc-status'),!runtime?.osc ? '設定を読み込み中' : runtime.osc.enabled ? runtime.osc.host + ':' + runtime.osc.port + ' · ' + runtime.osc.maxHz + ' Hz' : '停止中');
  $('osc-status').classList.toggle('active',Boolean(runtime?.osc?.enabled));
  const notifications = runtime?.notifications;
  const notificationsDisabled = !notifications || !notifications.supported || notificationsBusy;
  if ($('notifications-enabled').disabled !== notificationsDisabled) $('notifications-enabled').disabled = notificationsDisabled;
  if ($('notifications-apply').disabled !== (notificationsDisabled || !notificationsDirty)) $('notifications-apply').disabled = notificationsDisabled || !notificationsDirty;
  setText($('notifications-apply'),notificationsBusy ? '適用中…' : '適用');
  if ($('notifications-unsaved').hidden !== !notificationsDirty) $('notifications-unsaved').hidden = !notificationsDirty;
  setText($('notifications-status'),!notifications ? '設定を読み込み中' : !notifications.supported ? '未対応のOS' : notifications.error ? 'エラー' : notifications.enabled ? 'ON' : 'OFF');
  $('notifications-status').classList.toggle('active',Boolean(notifications?.supported && notifications.enabled && !notifications.error));
  setText($('notifications-hint'),notifications && !notifications.supported ? 'このOSでは通知を利用できません。' : 'OSの通知設定によりバナーの表示が制御されます。');
}
async function refreshRuntime() {
  if (disposed || runtimeRequest || connectionBusy || oscBusy || notificationsBusy || discoveryBusy) return runtimeRequest;
  const version = runtimeVersion;
  lastRuntimeRefresh = performance.now();
  runtimeRequest = (async () => {
    try {
      const next = await requestJson('/api/runtime');
      if (!disposed && version === runtimeVersion) applyRuntime(next);
    } catch (error) {
      if (!runtime) { connectionRuntimeError = error.message; renderConnectionError(); }
    } finally { runtimeRequest = undefined; }
  })();
  return runtimeRequest;
}

$('connection-form').addEventListener('input', () => { connectionDirty = true; updateControls(); });
$('connection-form').addEventListener('change', () => { connectionDirty = true; updateControls(); });
$('osc-form').addEventListener('input', () => { oscDirty = true; updateControls(); });
$('osc-form').addEventListener('change', () => { oscDirty = true; updateControls(); });
$('notifications-form').addEventListener('input', () => { notificationsDirty = true; updateControls(); });
$('notifications-form').addEventListener('change', () => { notificationsDirty = true; updateControls(); });
$('discovery-button').addEventListener('click', async () => {
  if ($('discovery-button').disabled) return;
  const payload = { interfaceName:$('interface-select').value };
  discoveryBusy = true; runtimeVersion++; discoveryRequestError = ''; discoveryRuntimeError = ''; renderDiscoveryError(); updateControls();
  try { applyRuntime(await requestJson('/api/discovery',payload)); }
  catch (error) { discoveryRequestError = error.message; renderDiscoveryError(); }
  finally { discoveryBusy = false; updateControls(); }
});
$('connection-form').addEventListener('submit', async event => {
  event.preventDefault();
  if ($('connect-button').disabled || !$('connection-form').reportValidity()) return;
  const method = $('method-select').value;
  const payload = { action:'connect', profile:$('device-select').value, interfaceName:$('interface-select').value, mode:['virtual-device','az-standalone'].includes(method) ? method : 'passive', backend:method === 'pcap' ? 'alphatheta' : 'native' };
  connectionBusy = true; runtimeVersion++; connectionRequestError = ''; connectionRuntimeError = ''; renderConnectionError(); updateControls();
  try { const next = await requestJson('/api/connection',payload); connectionDirty = false; applyRuntime(next); }
  catch (error) { connectionRequestError = error.message; renderConnectionError(); }
  finally { connectionBusy = false; updateControls(); }
});
$('disconnect-button').addEventListener('click', async () => {
  if ($('disconnect-button').disabled) return;
  connectionBusy = true; runtimeVersion++; connectionRequestError = ''; connectionRuntimeError = ''; renderConnectionError(); updateControls();
  try { applyRuntime(await requestJson('/api/connection',{ action:'disconnect' })); }
  catch (error) { connectionRequestError = error.message; renderConnectionError(); }
  finally { connectionBusy = false; updateControls(); }
});
$('osc-form').addEventListener('submit', async event => {
  event.preventDefault();
  if ($('osc-apply').disabled || !$('osc-form').reportValidity()) return;
  const payload = { enabled:$('osc-enabled').checked, host:$('osc-host').value.trim(), port:Number($('osc-port').value), maxHz:Number($('osc-rate').value), snapshotIntervalMs:Number($('osc-snapshot').value) };
  oscBusy = true; runtimeVersion++; message('osc-error',''); updateControls();
  try { const next = await requestJson('/api/osc',payload); oscDirty = false; applyRuntime(next); }
  catch (error) { message('osc-error',error.message); }
  finally { oscBusy = false; updateControls(); }
});
$('notifications-form').addEventListener('submit', async event => {
  event.preventDefault();
  if ($('notifications-apply').disabled) return;
  const payload = { enabled:$('notifications-enabled').checked };
  notificationsBusy = true; runtimeVersion++; notificationsRequestError = ''; notificationsRuntimeError = ''; renderNotificationsError(); updateControls();
  try { const next = await requestJson('/api/notifications',payload); notificationsDirty = false; applyRuntime(next); }
  catch (error) { notificationsRequestError = error.message; renderNotificationsError(); }
  finally { notificationsBusy = false; updateControls(); }
});

function makeDeck(deck) {
  const el = text('article','deck');
  const top = text('div','deck-top');
  const identity = text('div','deck-id');
  const name = text('div','deck-name'); name.append(text('span','deck-label'),text('span','deck-model'));
  identity.append(text('span','deck-number'),name);
  const playback = text('span','play-state'); playback.append(text('i'),text('span')); top.append(identity,playback);
  const tempo = text('div','tempo-row');
  const bpm = text('div','bpm'); bpm.append(text('strong','bpm-value'),text('span','bpm-unit','実効BPM'));
  const pitch = text('div','pitch'); pitch.append(text('span','','ピッチ'),text('strong')); tempo.append(bpm,pitch);
  const beats = text('div','beat-row'); for(let i=0;i<4;i++) beats.append(text('i','beat-cell')); beats.append(text('span','beat-note','拍 未取得'));
  const track = text('div','track-info');
  const copy = text('div','track-copy'); copy.append(text('div','track-title'),text('div','track-artist'));
  const id = text('div','track-id'); id.append(text('span','','曲ID'),text('strong')); track.append(copy,id);
  const metrics = text('div','deck-metrics');
  for (const label of ['トラックBPM','再生位置','On Air']) { const metric = text('div','metric'); metric.append(text('span','',label),text('strong')); metrics.append(metric); }
  const bottom = text('div','deck-bottom'); const fresh = text('span','freshness'); fresh.append(text('i'),text('span')); bottom.append(fresh,text('span','wire-id'));
  const details = text('details'); details.append(text('summary','','機能・データソース'),text('div','capabilities'),text('p','details-source'));
  el.append(top,tempo,beats,track,metrics,bottom,details);
  deckNodes.set(deck.deckId,el); return el;
}
function updateDeck(deck) {
  const el = deckNodes.get(deck.deckId) ?? makeDeck(deck);
  const stale = deck.effectiveBpm?.freshness === 'stale' || deck.playbackState?.freshness === 'stale';
  el.classList.toggle('stale',stale);
  const logicalDeck = String(deck.logicalDeck ?? 'unknown');
  if (el.dataset.logicalDeck !== logicalDeck) el.dataset.logicalDeck = logicalDeck;
  setText(el.querySelector('.deck-number'),deck.logicalDeck === null ? '?' : String(deck.logicalDeck).padStart(2,'0'));
  setText(el.querySelector('.deck-label'),deck.logicalDeck === null ? '未確定のデッキ' : 'Deck ' + deck.logicalDeck);
  setText(el.querySelector('.deck-model'),deck.model ?? '不明な機器');
  const play = deck.playbackState?.quality === 'unknown' ? 'unknown' : value(deck.playbackState) ?? 'unknown';
  const playing = ['playing','looping','cue_playing'].includes(play) && deck.playbackState?.freshness === 'fresh' && !stale;
  el.classList.toggle('is-playing',playing);
  const badge = el.querySelector('.play-state'); badge.classList.toggle('playing',playing); setText(badge.querySelector('span'),stale ? '受信停止 · STALE' : playLabels[play] ?? '不明');
  const numeric = value(deck.effectiveBpm); const bpm = el.querySelector('.bpm-value');
  const bpmText = typeof numeric === 'number' && Number.isFinite(numeric) ? numeric.toFixed(2) : '—';
  if (bpm.dataset.value !== bpmText) {
    bpm.dataset.value = bpmText;
    if (bpmText === '—') setText(bpm,bpmText);
    else { const parts = bpmText.split('.'); bpm.replaceChildren(document.createTextNode(parts[0]),text('small','','.' + parts[1])); }
  }
  const pitch = value(deck.pitchPercent); setText(el.querySelector('.pitch strong'),typeof pitch === 'number' ? (pitch >= 0 ? '+' : '') + pitch.toFixed(2) + '%' : '—');
  const beat = value(deck.beat); const phase = value(deck.beatPhase);
  const observed = deck.beat?.quality === 'observed' && deck.beat?.freshness === 'fresh' && typeof beat === 'number';
  const beatInMeasure = deck.raw?.beatInMeasure;
  const beatIndex = observed && Number.isInteger(beatInMeasure) && beatInMeasure >= 1 && beatInMeasure <= 4 ? beatInMeasure - 1 : -1;
  [...el.querySelectorAll('.beat-cell')].forEach((node,index) => node.classList.toggle('active',index === beatIndex));
  const phaseStale = phase !== null && deck.beatPhase?.freshness === 'stale'; const beatNote = el.querySelector('.beat-note');
  setText(beatNote,observed ? '拍 ' + beat : phaseStale ? '拍位相 · STALE' : phase !== null ? '拍位相 ' + phase : '拍 未取得');
  beatNote.classList.toggle('field-stale',!observed && phaseStale); beatNote.title = !observed && phaseStale ? '最後の受信値: ' + phase : '';
  for (const [selector,field,fallback] of [['.track-title',deck.title,'曲名 未取得'],['.track-artist',deck.artist,'アーティスト 未取得']]) {
    const node = el.querySelector(selector); setText(node,value(field) === null ? fallback : value(field) + (field.freshness === 'stale' ? ' · STALE' : '')); node.classList.toggle('field-stale',value(field) !== null && field.freshness === 'stale');
    if (node.title !== node.textContent) node.title = node.textContent;
  }
  setText(el.querySelector('.track-id strong'),deck.trackRef?.trackId ?? '—');
  const metric = el.querySelectorAll('.metric strong'); const position = value(deck.positionMs); const positionStale = position !== null && deck.positionMs?.freshness === 'stale';
  setText(metric[0],format(deck.trackBpm)); metric[0].classList.toggle('field-stale',deck.trackBpm?.freshness === 'stale');
  setText(metric[1],positionStale ? '— · STALE' : position === null ? '—' : duration(position)); metric[1].classList.toggle('field-stale',positionStale); metric[1].title = positionStale ? '最後の受信値: ' + duration(position) : '';
  setText(metric[2],value(deck.onAir) === null ? '—' : deck.onAir.freshness === 'stale' ? '— · STALE' : value(deck.onAir) ? 'ON' : 'OFF');
  setText(el.querySelector('.freshness span'),stale ? '最後の受信値' : deck.effectiveBpm?.quality === 'observed' ? '観測値' : '未取得');
  setText(el.querySelector('.wire-id'),'通信番号 ' + deck.wireDeviceId + ' / OSC ' + (deck.publicDeckId ?? '未設定'));
  const capabilities = el.querySelector('.capabilities');
  const items = Object.entries(deck.capabilities ?? {}).sort(([a],[b]) => a.localeCompare(b));
  const capabilityKey = JSON.stringify(items.map(([key,cap]) => [key,cap.verification,cap.availability,cap.reason]));
  if (capabilities.dataset.key !== capabilityKey) {
    const rows = items.map(([key,cap]) => { const row = text('div','capability'); row.append(text('span','',key),text('span','',(cap.verification ?? 'unknown') + ' / ' + (cap.availability ?? 'idle'))); row.title = cap.reason ?? ''; return row; });
    capabilities.replaceChildren(...rows); capabilities.dataset.key = capabilityKey;
  }
  setText(el.querySelector('.details-source'),(deck.effectiveBpm?.source ?? 'unknown') + '\n' + deck.profile + ' · FW ' + (deck.raw?.firmware ?? 'unknown') + '\n' + deck.deckId);
  return el;
}
function renderDiagnostics(diagnostics) {
  setText($('diagnostic-count'),diagnostics.length + ' 件');
  const key = JSON.stringify(diagnostics.slice(-30));
  if (key === diagnosticKey) return;
  diagnosticKey = key;
  const nodes = diagnostics.slice(-30).reverse().map(diagnostic => {
    const el = text('div','diagnostic ' + (diagnostic.level ?? '')); el.append(text('time','',duration(diagnostic.observedAt ?? 0)));
    const copy = text('div','diag-message'); copy.append(text('span','diag-tag',diagnostic.code ?? 'SESSION'),document.createTextNode(diagnostic.message ?? diagnostic.reason ?? '')); el.append(copy); return el;
  });
  $('diagnostics').replaceChildren(...(nodes.length ? nodes : [text('p','subtle','診断情報はありません。')]));
}
function render() {
  if (!snapshot) return;
  setText($('source-mode'),modeLabels[snapshot.session.mode] ?? '');
  const demoHidden = snapshot.session.mode !== 'demo';
  if ($('demo-notice').hidden !== demoHidden) $('demo-notice').hidden = demoHidden;
  setText($('deck-count'),snapshot.decks.length + ' デッキ');
  const decks = [...snapshot.decks].sort((a,b) => (a.logicalDeck ?? Infinity) - (b.logicalDeck ?? Infinity) || a.deckId.localeCompare(b.deckId));
  const nodes = decks.map(deck => {
    if (!deckNodes.has(deck.deckId) || deckRevisions.get(deck.deckId) !== deck.stateRevision) {
      updateDeck(deck); deckRevisions.set(deck.deckId,deck.stateRevision);
    }
    return deckNodes.get(deck.deckId);
  });
  reconcileChildren($('decks'),nodes.length ? nodes : [emptyState]);
  for (const id of deckNodes.keys()) if (!snapshot.decks.some(deck => deck.deckId === id)) { deckNodes.delete(id); deckRevisions.delete(id); }
  renderSessionDetails(snapshot.session);
  renderDiagnostics(snapshot.diagnostics ?? []); updateControls();
  const key = [snapshot.session.id,snapshot.session.mode,snapshot.session.state,snapshot.session.interfaceId].join('|');
  if (key !== lastSessionKey) { lastSessionKey = key; if (performance.now() - lastRuntimeRefresh > 1000) void refreshRuntime(); }
}
function connectSocket() {
  if (disposed) return;
  socket = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws');
  socket.addEventListener('open',() => { $('socket-dot').className = 'dot connected'; $('socket-status').textContent = '画面接続済み'; void refreshRuntime(); });
  socket.addEventListener('message',event => {
    try {
      const incoming = JSON.parse(event.data); if (incoming.schemaVersion !== 1) return;
      if (incoming.type === 'snapshot') { snapshot = incoming; deckRevisions.clear(); }
      else if (incoming.type === 'delta') {
        if (!snapshot || incoming.baseRevision !== snapshot.revision) { socket.send(JSON.stringify({ type:'resync' })); return; }
        const decks = new Map(snapshot.decks.map(deck => [deck.deckId,deck])); for (const id of incoming.removedDeckIds ?? []) decks.delete(id); for (const deck of incoming.decks ?? []) decks.set(deck.deckId,deck);
        snapshot = { ...snapshot,revision:incoming.revision,session:incoming.session,representative:incoming.representative ?? snapshot.representative,diagnostics:incoming.diagnostics,devices:incoming.devices ?? snapshot.devices,decks:[...decks.values()] };
      } else return;
      // Capture nonempty messages before frame coalescing: a following status
      // packet may already clear reason before the scheduled render runs.
      rememberSessionReason(snapshot.session);
      scheduleRender();
    } catch { $('socket-status').textContent = '状態を再取得中'; socket.send(JSON.stringify({ type:'resync' })); }
  });
  socket.addEventListener('close',() => {
    $('socket-dot').className = 'dot error'; $('socket-status').textContent = '画面の再接続を待機';
    if (snapshot) { snapshot.session = { ...snapshot.session,state:'disconnected',reason:'画面との接続が途絶えています。' }; snapshot.representative = { deckId:null,publicDeckId:null,reason:'none' }; for (const deck of snapshot.decks) { for (const field of Object.values(deck)) if (field && typeof field === 'object' && 'freshness' in field) field.freshness = 'stale'; } deckRevisions.clear(); scheduleRender(); }
    if (!disposed) reconnect = setTimeout(connectSocket,1500);
  });
  socket.addEventListener('error',() => socket.close());
}
const runtimePoll = setInterval(() => { void refreshRuntime(); },4000);
addEventListener('pagehide',() => { disposed = true; clearInterval(runtimePoll); clearTimeout(reconnect); clearTimeout(renderTimer); socket?.close(); });
updateControls();
void refreshRuntime();
connectSocket();
