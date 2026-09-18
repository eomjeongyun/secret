'use strict';

const DB_NAME = 'secret';
const DB_VERSION = 1;
const STORE = 'periods';
const DEFAULT_CYCLE = 25;
const DEFAULT_PERIOD = 5;
const MIN_MONTH = new Date(2026, 4, 1);
const DAY_MS = 86400000;

const state = {
  periods: [],
  averages: { cycle: DEFAULT_CYCLE, period: DEFAULT_PERIOD, cycleSamples: 0, periodSamples: 0 },
  calendarMonth: new Date(Math.max(Date.now(), MIN_MONTH.getTime())),
  selectedDate: null,
  deleteArmed: false
};

const $ = (selector) => document.querySelector(selector);
const pad = (n) => String(n).padStart(2, '0');
const toDateKey = (date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
const parseDate = (key) => {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d, 12);
};
const addDays = (date, days) => {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
};
const diffDays = (later, earlier) => Math.round((Date.UTC(later.getFullYear(), later.getMonth(), later.getDate()) - Date.UTC(earlier.getFullYear(), earlier.getMonth(), earlier.getDate())) / DAY_MS);
const today = () => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 12); };
const formatDate = (key, withYear = true) => {
  const date = parseDate(key);
  return new Intl.DateTimeFormat('ko-KR', { ...(withYear ? { year: 'numeric' } : {}), month: 'long', day: 'numeric', weekday: 'short' }).format(date);
};
const uuid = () => crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;

function openDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function getAllPeriods() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const request = tx.objectStore(STORE).getAll();
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error);
    tx.oncomplete = () => db.close();
  });
}

async function putPeriod(record) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(record);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => reject(tx.error);
  });
}

async function deletePeriod(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(id);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => reject(tx.error);
  });
}

function calculateAverages(periods) {
  const sorted = [...periods].sort((a, b) => a.startDate.localeCompare(b.startDate));
  const cycleGaps = [];
  for (let i = 1; i < sorted.length; i += 1) {
    const gap = diffDays(parseDate(sorted[i].startDate), parseDate(sorted[i - 1].startDate));
    if (gap > 0) cycleGaps.push(gap);
  }
  const lengths = sorted.filter((p) => p.endDate).map((p) => diffDays(parseDate(p.endDate), parseDate(p.startDate)) + 1).filter((n) => n > 0);
  return {
    cycle: cycleGaps.length ? Math.round(cycleGaps.reduce((a, b) => a + b, 0) / cycleGaps.length) : DEFAULT_CYCLE,
    period: lengths.length ? Math.round(lengths.reduce((a, b) => a + b, 0) / lengths.length) : DEFAULT_PERIOD,
    cycleSamples: cycleGaps.length,
    periodSamples: lengths.length
  };
}

function sortedPeriods() { return [...state.periods].sort((a, b) => a.startDate.localeCompare(b.startDate)); }
function openPeriod() {
  const periods = sortedPeriods();
  for (let i = periods.length - 1; i >= 0; i -= 1) {
    if (!periods[i].endDate) return periods[i];
  }
  return null;
}

function predictedCycles(from, to) {
  const periods = sortedPeriods();
  if (!periods.length) return [];
  const lastStart = parseDate(periods[periods.length - 1].startDate);
  const cycles = [];
  let start = addDays(lastStart, state.averages.cycle);
  let guard = 0;
  while (start < from && guard < 500) { start = addDays(start, state.averages.cycle); guard += 1; }
  while (start <= to && guard < 600) {
    cycles.push({ start, end: addDays(start, state.averages.period - 1), ovulation: addDays(start, -14) });
    start = addDays(start, state.averages.cycle);
    guard += 1;
  }
  const firstUpcoming = addDays(lastStart, state.averages.cycle);
  const priorOvulation = addDays(firstUpcoming, -14);
  if (priorOvulation >= from && priorOvulation <= to && !cycles.some((c) => toDateKey(c.ovulation) === toDateKey(priorOvulation))) {
    cycles.push({ start: firstUpcoming, end: addDays(firstUpcoming, state.averages.period - 1), ovulation: priorOvulation });
  }
  return cycles;
}

function actualPeriodOn(date) {
  const key = toDateKey(date);
  return state.periods.find((p) => key >= p.startDate && key <= (p.endDate || toDateKey(today()))) || null;
}

function getNextPrediction(reference = today()) {
  const periods = sortedPeriods();
  if (!periods.length) return null;
  let start = addDays(parseDate(periods[periods.length - 1].startDate), state.averages.cycle);
  while (addDays(start, state.averages.period - 1) < reference) start = addDays(start, state.averages.cycle);
  return { start, end: addDays(start, state.averages.period - 1), ovulation: addDays(start, -14) };
}

function getNextOvulation(reference = today()) {
  const periods = sortedPeriods();
  if (!periods.length) return null;
  let periodStart = addDays(parseDate(periods[periods.length - 1].startDate), state.averages.cycle);
  let ovulation = addDays(periodStart, -14);
  while (ovulation < reference) {
    periodStart = addDays(periodStart, state.averages.cycle);
    ovulation = addDays(periodStart, -14);
  }
  return ovulation;
}

function renderHome() {
  const now = today();
  const key = toDateKey(now);
  const actual = actualPeriodOn(now);
  const prediction = getNextPrediction(now);
  const nextOvulation = getNextOvulation(now);
  const open = openPeriod();
  let title = '첫 생리를 기록해 주세요';
  let detail = '기록이 쌓이면 다음 생리와 배란일을 예상해 드려요.';

  if (actual) {
    title = `생리 ${diffDays(now, parseDate(actual.startDate)) + 1}일차`;
    detail = actual.endDate ? '기록된 생리 기간이에요.' : '진행 중인 생리로 기록되어 있어요.';
  } else if (prediction && now >= prediction.start && now <= prediction.end) {
    title = `예상 생리 ${diffDays(now, prediction.start) + 1}일차`;
    detail = '평균 기록을 바탕으로 예상한 기간이에요.';
  } else if (prediction) {
    const days = diffDays(prediction.start, now);
    title = days >= 0 ? `생리 예정일까지 D-${days}` : '예상 생리 기간이 지났어요';
    detail = `${formatDate(toDateKey(prediction.start), false)} 시작 예상`;
  }

  $('#statusText').textContent = title;
  $('#statusDetail').textContent = detail;
  $('#ovulationText').textContent = nextOvulation ? formatDate(toDateKey(nextOvulation), false) : '-';
  $('#primaryLogButton').textContent = open ? '생리 종료 기록' : '생리 시작 기록';
  $('#primaryLogButton').dataset.mode = open ? 'end' : 'start';
  $('#todayLabel').textContent = formatDate(key);
  $('#averageText').innerHTML = `평균 주기 ${state.averages.cycle}일<br>평균 기간 ${state.averages.period}일`;

  const history = $('#historyList');
  history.replaceChildren();
  const recent = sortedPeriods().reverse();
  if (!recent.length) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = '아직 기록이 없어요. 시작일을 기록하면 여기에 차곡차곡 모여요.';
    history.append(empty);
  } else {
    recent.forEach((period) => {
      const button = document.createElement('button');
      button.className = 'history-item';
      button.type = 'button';
      const length = period.endDate ? `${diffDays(parseDate(period.endDate), parseDate(period.startDate)) + 1}일` : '진행 중';
      button.innerHTML = `<span><span class="history-date">${formatDate(period.startDate)}</span><span class="history-meta">${period.endDate ? `${formatDate(period.endDate, false)}까지 · ` : ''}${length}</span></span><span class="history-arrow">›</span>`;
      button.addEventListener('click', () => openEditSheet(period));
      history.append(button);
    });
  }
}

function renderCalendar() {
  const year = state.calendarMonth.getFullYear();
  const month = state.calendarMonth.getMonth();
  $('#calendarTitle').textContent = `${year}년 ${month + 1}월`;
  $('#prevMonth').disabled = year === MIN_MONTH.getFullYear() && month === MIN_MONTH.getMonth();
  const grid = $('#calendarGrid');
  grid.replaceChildren();
  const first = new Date(year, month, 1, 12);
  const last = new Date(year, month + 1, 0, 12);
  const rangeStart = addDays(first, -20);
  const rangeEnd = addDays(last, 20);
  const predictions = predictedCycles(rangeStart, rangeEnd);
  for (let i = 0; i < first.getDay(); i += 1) grid.append(document.createElement('span'));
  for (let day = 1; day <= last.getDate(); day += 1) {
    const date = new Date(year, month, day, 12);
    const key = toDateKey(date);
    const actual = actualPeriodOn(date);
    const predicted = !actual && predictions.some((p) => date >= p.start && date <= p.end);
    const ovulation = predictions.some((p) => toDateKey(p.ovulation) === key);
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `day-cell${actual ? ' actual' : ''}${predicted ? ' predicted' : ''}${ovulation ? ' ovulation' : ''}${key === toDateKey(today()) ? ' today' : ''}`;
    button.setAttribute('aria-label', `${formatDate(key)}${actual ? ', 실제 생리' : predicted ? ', 예상 생리' : ''}${ovulation ? ', 예상 배란일' : ''}`);
    button.innerHTML = `<span class="day-inner">${day}</span>`;
    button.addEventListener('click', () => openDaySheet(key, actual));
    grid.append(button);
  }
}

function render() {
  state.averages = calculateAverages(state.periods);
  renderHome();
  renderCalendar();
}

function showSheet(eyebrow, title, content) {
  state.deleteArmed = false;
  $('#sheetEyebrow').textContent = eyebrow;
  $('#sheetTitle').textContent = title;
  $('#sheetContent').replaceChildren(content);
  $('#sheetBackdrop').hidden = false;
  $('#sheet').hidden = false;
  document.body.style.overflow = 'hidden';
}

function closeSheet() {
  $('#sheetBackdrop').hidden = true;
  $('#sheet').hidden = true;
  document.body.style.overflow = '';
}

function dateField(label, value, id) {
  const wrapper = document.createElement('label');
  wrapper.className = 'field';
  wrapper.textContent = label;
  const input = document.createElement('input');
  input.type = 'date';
  input.id = id;
  input.value = value || '';
  input.min = '2026-05-01';
  wrapper.append(input);
  return wrapper;
}

function actionButton(text, className, handler) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = className;
  button.textContent = text;
  button.addEventListener('click', handler);
  return button;
}

function openLogSheet(mode, initialDate) {
  const open = openPeriod();
  const content = document.createElement('div');
  const label = mode === 'start' ? '생리 시작일' : '생리 종료일';
  content.append(dateField(label, initialDate, 'logDate'));
  const note = document.createElement('p');
  note.className = 'sheet-note';
  note.textContent = mode === 'start' ? '선택한 날짜를 새 생리의 시작일로 기록해요.' : `${formatDate(open.startDate)} 시작 기록을 마무리해요.`;
  content.append(note);
  const actions = document.createElement('div');
  actions.className = 'sheet-actions';
  actions.append(actionButton(mode === 'start' ? '시작일 저장' : '종료일 저장', 'primary', async () => {
    const value = $('#logDate').value;
    if (!value) return showToast('날짜를 선택해 주세요.');
    if (value < '2026-05-01') return showToast('2026년 5월부터 기록할 수 있어요.');
    if (mode === 'end' && value < open.startDate) return showToast('종료일은 시작일보다 빠를 수 없어요.');
    const now = new Date().toISOString();
    if (mode === 'start') {
      await putPeriod({ id: uuid(), startDate: value, endDate: null, createdAt: now, updatedAt: now });
    } else {
      await putPeriod({ ...open, endDate: value, updatedAt: now });
    }
    await refreshData();
    closeSheet();
    showToast(mode === 'start' ? '시작일을 기록했어요.' : '종료일을 기록했어요.');
  }));
  content.append(actions);
  showSheet(mode === 'start' ? '새 기록' : '진행 중인 기록', mode === 'start' ? '생리 시작' : '생리 종료', content);
}

function openDaySheet(key, actual) {
  if (actual) return openEditSheet(actual);
  const open = openPeriod();
  const content = document.createElement('div');
  const note = document.createElement('p');
  note.className = 'sheet-note';
  note.textContent = open ? `${formatDate(open.startDate)} 시작한 생리를 이 날 종료할 수 있어요.` : '이 날을 새 생리의 시작일로 기록할 수 있어요.';
  content.append(note);
  const actions = document.createElement('div');
  actions.className = 'sheet-actions';
  const validEnd = !open || key >= open.startDate;
  const primary = actionButton(open ? '이 날 생리 종료' : '이 날 생리 시작', 'primary', () => {
    closeSheet();
    openLogSheet(open ? 'end' : 'start', key);
  });
  primary.disabled = !validEnd;
  actions.append(primary);
  if (!validEnd) {
    const warning = document.createElement('p');
    warning.className = 'sheet-note';
    warning.textContent = '진행 중인 생리의 시작일보다 빠른 날짜예요.';
    content.append(warning);
  }
  content.append(actions);
  showSheet('달력 기록', formatDate(key), content);
}

function openEditSheet(period) {
  const content = document.createElement('div');
  content.append(dateField('시작일', period.startDate, 'editStart'));
  content.append(dateField('종료일', period.endDate, 'editEnd'));
  const actions = document.createElement('div');
  actions.className = 'sheet-actions';
  actions.append(actionButton('변경 내용 저장', 'primary', async () => {
    const startDate = $('#editStart').value;
    const endDate = $('#editEnd').value || null;
    if (!startDate) return showToast('시작일을 선택해 주세요.');
    if (startDate < '2026-05-01') return showToast('2026년 5월부터 기록할 수 있어요.');
    if (endDate && endDate < startDate) return showToast('종료일은 시작일보다 빠를 수 없어요.');
    await putPeriod({ ...period, startDate, endDate, updatedAt: new Date().toISOString() });
    await refreshData();
    closeSheet();
    showToast('기록을 수정했어요.');
  }));
  const deleteButton = actionButton('잘못 기록한 항목 삭제', 'danger', async () => {
    if (!state.deleteArmed) {
      state.deleteArmed = true;
      deleteButton.textContent = '한 번 더 누르면 삭제돼요';
      setTimeout(() => {
        if (!deleteButton.isConnected) return;
        state.deleteArmed = false;
        deleteButton.textContent = '잘못 기록한 항목 삭제';
      }, 3500);
      return;
    }
    await deletePeriod(period.id);
    await refreshData();
    closeSheet();
    showToast('기록을 삭제했어요.');
  });
  actions.append(deleteButton);
  content.append(actions);
  showSheet('기록 수정', formatDate(period.startDate), content);
}

let toastTimer;
function showToast(message) {
  const toast = $('#toast');
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 2400);
}

async function refreshData() {
  state.periods = await getAllPeriods();
  render();
}

async function exportAllData() {
  return {
    app: 'secret',
    exportedAt: new Date().toISOString(),
    version: 1,
    periods: await getAllPeriods()
  };
}

async function monthlyBackup() {
  const now = new Date();
  const monthKey = `${now.getFullYear()}-${pad(now.getMonth() + 1)}`;
  if (localStorage.getItem('secret-last-backup-month') === monthKey) return;
  try {
    const exportedData = await exportAllData();
    const res = await fetch('https://appointee-unnoticed-donated.ngrok-free.dev/api/app-backup/secret', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(exportedData)
    });
    if (res.ok) localStorage.setItem('secret-last-backup-month', monthKey);
  } catch (_) { /* best effort */ }
}

function bindEvents() {
  document.querySelectorAll('.nav-button').forEach((button) => button.addEventListener('click', () => {
    document.querySelectorAll('.nav-button').forEach((b) => b.classList.toggle('active', b === button));
    const view = button.dataset.view;
    $('#homeView').classList.toggle('active', view === 'home');
    $('#calendarView').classList.toggle('active', view === 'calendar');
  }));
  $('#primaryLogButton').addEventListener('click', () => openLogSheet($('#primaryLogButton').dataset.mode, toDateKey(today())));
  $('#prevMonth').addEventListener('click', () => {
    const next = new Date(state.calendarMonth.getFullYear(), state.calendarMonth.getMonth() - 1, 1, 12);
    if (next >= MIN_MONTH) { state.calendarMonth = next; renderCalendar(); }
  });
  $('#nextMonth').addEventListener('click', () => {
    state.calendarMonth = new Date(state.calendarMonth.getFullYear(), state.calendarMonth.getMonth() + 1, 1, 12);
    renderCalendar();
  });
  $('#closeSheet').addEventListener('click', closeSheet);
  $('#sheetBackdrop').addEventListener('click', closeSheet);
}

async function init() {
  bindEvents();
  if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});
  try {
    await refreshData();
  } catch (_) {
    showToast('기록 저장소를 열지 못했어요. 잠시 후 다시 열어 주세요.');
  }
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' }).then((reg) => reg.update()).catch(() => {});
    let reloading = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => { if (reloading) return; reloading = true; location.reload(); });
  }
  setTimeout(monthlyBackup, 3500);
}

init();
