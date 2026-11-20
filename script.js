const STORAGE_KEY = "timeframe-planner-v1";
const AUTH_STORAGE_KEY = "timeframe-supabase-session-v1";
const ACCOUNT_MODE_KEY = "timeframe-account-mode-v1";
const weekdays = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const initialEvents = [
  { day: 0, start: 420, end: 540, title: "PATHFIT 2", instructor: "BAUTISTA, BRYAN JOSEPH", location: "VALENCIA D", color: "blue" },
  { day: 0, start: 600, end: 780, title: "Programming Logic and Design G1", instructor: "Cruz, Januarius", location: "NH403", color: "yellow" },
  { day: 0, start: 840, end: 1020, title: "Calculus 2", instructor: "CHRISTOPHER MORONIA", location: "NH501", color: "green" },
  { day: 0, start: 1020, end: 1200, title: "Physics for Engineers - Laboratory", instructor: "RAMOS, ANGELICA", location: "NH 504", color: "pink" },
  { day: 1, start: 510, end: 600, title: "AE 101 Academic English", instructor: "Pineda, Florentino", location: "NH 509", color: "green" },
  { day: 1, start: 600, end: 780, title: "NSTP 11", instructor: "JAMES JIMENEZ", location: "201 A", color: "pink" },
  { day: 1, start: 780, end: 840, title: "CPE 103 Computer Engineering as a Discipline", instructor: "MUNOZ, JANNINE S.", location: "NH 509", color: "red" },
  { day: 1, start: 930, end: 1020, title: "RPH-101 Readings in the Philippine History", instructor: "Gabriel, John Carlo", location: "201A", color: "yellow" },
  { day: 2, start: 600, end: 780, title: "Programming Logic and Design G1", instructor: "Cruz, Januarius", location: "NH402", color: "yellow" },
  { day: 2, start: 840, end: 1020, title: "Computer Hardware Fundamentals", instructor: "ARAI HIROYOSHI", location: "CPE 2301A", color: "red" },
  { day: 2, start: 1020, end: 1200, title: "Physics for Engineers - Lecture", instructor: "RAMOS, ANGELICA", location: "NH 409", color: "orange" },
  { day: 3, start: 600, end: 720, title: "Science, Technology and Society", instructor: "SAMSON, Christian Lay", location: "CPE 2 - 407", color: "blue" },
  { day: 3, start: 840, end: 930, title: "RPH-101 Readings in the Philippine History", instructor: "Gabriel, John Carlo", location: "201A", color: "yellow" },
  { day: 4, start: 420, end: 510, title: "AE 101 Academic English", instructor: "Pineda, Florentino", location: "CPE 2 - 404", color: "green" },
  { day: 4, start: 690, end: 750, title: "Science, Technology and Society", instructor: "SAMSON, Christian Lay", location: "CPE 2 - 303", color: "blue" }
];
const initialTasks = [
  { title: "Yoga Exercise With Friends", list: "my", checked: false },
  { title: "Cardio Training With Jesslyn", list: "my", checked: true },
  { title: "Webinar Reminder Holiday", list: "other", checked: true },
  { title: "Birthday Greeting Winks Lily Smith", list: "other", checked: true }
];

const supabaseConfig = window.TIMEFRAME_SUPABASE_CONFIG || {};
const supabaseUrl = String(supabaseConfig.url || "").replace(/\/+$/, "");
const supabaseAnonKey = String(supabaseConfig.anonKey || "");
const supabaseConfigured = Boolean(supabaseUrl && supabaseAnonKey);

function accountStorageKey(userId) {
  return `${STORAGE_KEY}:user:${userId}`;
}

function readAuthSession() {
  try {
    const saved = JSON.parse(localStorage.getItem(AUTH_STORAGE_KEY) || "null");
    return saved && saved.user?.id && saved.access_token && saved.refresh_token ? saved : null;
  } catch (error) {
    console.warn("Could not restore the signed-in account.", error);
    return null;
  }
}

let authSession = readAuthSession();
let activeStorageKey = authSession ? accountStorageKey(authSession.user.id) : STORAGE_KEY;
let accountModeEnabled = localStorage.getItem(ACCOUNT_MODE_KEY) === "required";
let cloudSyncReady = false;
let applyingRemoteData = false;
let cloudSaveTimer = null;
let cloudSaveInProgress = false;
let cloudDirty = false;
let cloudLoadFailed = false;
let accountActivationInProgress = false;
let lastRemoteUpdatedAt = "";
let googleApiBase = String(supabaseConfig.googleApiUrl || `${location.protocol}//localhost:4174`).replace(/\/+$/, "");

function normalizePlannerData(saved) {
  const data = saved && typeof saved === "object" ? saved : {};
  return {
    events: Array.isArray(data.events) ? data.events : initialEvents.map(event => ({ ...event })),
    tasks: Array.isArray(data.tasks) ? data.tasks : initialTasks.map(task => ({ ...task })),
    deletedGoogleEventIds: Array.isArray(data.deletedGoogleEventIds) ? data.deletedGoogleEventIds : [],
    settings: data.settings && typeof data.settings === "object" ? data.settings : {}
  };
}

function readSavedState(storageKey = STORAGE_KEY) {
  try {
    return normalizePlannerData(JSON.parse(localStorage.getItem(storageKey) || "{}"));
  } catch (error) {
    console.warn("Could not load saved planner settings.", error);
    return normalizePlannerData({});
  }
}

const state = accountModeEnabled && !authSession ? normalizePlannerData({}) : readSavedState(activeStorageKey);
let events = state.events.map((item, index) => ({ ...item, id: item.id || `timeframe-${index}-${Math.random().toString(36).slice(2, 8)}` }));
let tasks = state.tasks;
let deletedGoogleEventIds = state.deletedGoogleEventIds;
let settings = { name: "", calendarTitle: "My Calendar", otherCalendarTitle: "Other Calendar", accentColor: "#007aff", theme: "light", ...state.settings };
let range = "Weekly";
let activePage = accountModeEnabled && !authSession ? "settings" : "dashboard";
let selectedDate = new Date();
let viewStart = startOfWeek(selectedDate);
let monthCursor = new Date(selectedDate.getFullYear(), selectedDate.getMonth(), 1);
let editingEventIndex = null;
let editingTaskIndex = null;
let googleConnected = false;
let googleSyncInProgress = false;
let googlePopup = null;

const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const eventDialog = $("#eventDialog");
const taskDialog = $("#taskDialog");
const eventForm = $("#eventForm");
const taskForm = $("#taskForm");

function startOfWeek(date) {
  const start = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
  return start;
}

function dateAtOffset(date, offset) {
  const result = new Date(date);
  result.setDate(result.getDate() + offset);
  return result;
}

function dateString(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function eventOccursOnDate(item, date) {
  return item.frequency === "once" ? item.date === dateString(date) : item.day === dayIndex(date);
}

function createEventId() {
  return `timeframe-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function toMinutes(value) {
  const [hours, minutes] = value.split(":").map(Number);
  return hours * 60 + minutes;
}

function timeText(minutes) {
  const hour = Math.floor(minutes / 60);
  const minute = minutes % 60;
  return `${hour % 12 || 12}:${String(minute).padStart(2, "0")}${hour < 12 ? "AM" : "PM"}`;
}

function escapeHTML(value) {
  return String(value).replace(/[&<>"']/g, character => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[character]);
}

function saveState() {
  const data = { events, tasks, deletedGoogleEventIds, settings };
  try {
    localStorage.setItem(activeStorageKey, JSON.stringify(data));
  } catch (error) {
    console.error("Could not save planner changes.", error);
  }
  if (authSession && !applyingRemoteData) {
    if (cloudSyncReady) scheduleCloudSave();
    else if (cloudLoadFailed) cloudDirty = true;
  }
}

function dayIndex(date) {
  return (date.getDay() + 6) % 7;
}

function formatMonth(date) {
  return date.toLocaleDateString("en-US", { month: "long", year: "numeric" });
}

function renderMiniCalendar() {
  $("#miniMonth").textContent = formatMonth(monthCursor);
  const container = $("#miniDays");
  container.innerHTML = "";
  const first = new Date(monthCursor.getFullYear(), monthCursor.getMonth(), 1);
  const start = new Date(first);
  const firstOffset = (first.getDay() + 6) % 7;
  start.setDate(1 - firstOffset);
  const daysInMonth = new Date(monthCursor.getFullYear(), monthCursor.getMonth() + 1, 0).getDate();
  const cellCount = Math.ceil((firstOffset + daysInMonth) / 7) * 7;

  for (let i = 0; i < cellCount; i++) {
    const date = dateAtOffset(start, i);
    const button = document.createElement("button");
    button.className = "mini-day";
    if (date.getMonth() !== monthCursor.getMonth()) button.classList.add("muted");
    if (sameDate(date, selectedDate)) button.classList.add("selected");
    button.textContent = date.getDate();
    button.addEventListener("click", () => selectDate(date));
    container.appendChild(button);
  }
}

function sameDate(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function selectDate(date) {
  selectedDate = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  viewStart = startOfWeek(selectedDate);
  monthCursor = new Date(selectedDate.getFullYear(), selectedDate.getMonth(), 1);
  renderMiniCalendar();
  renderCalendar();
}

function visibleDays() {
  if (range === "Daily") return [new Date(selectedDate)];
  return Array.from({ length: 7 }, (_, index) => dateAtOffset(viewStart, index));
}

function renderCalendar() {
  const dateStrip = $("#dateStrip");
  const dateStripScroll = $("#dateStripScroll");
  const schedule = $(".schedule-scroll");
  const monthGrid = $("#monthGridWrap");
  const days = visibleDays();
  $("#calendarView").classList.toggle("daily-view", range === "Daily");
  $("#calendarView").classList.toggle("weekly-view", range === "Weekly");
  $("#weekTitle").textContent = range === "Monthly"
    ? formatMonth(monthCursor)
    : range === "Daily"
      ? selectedDate.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })
      : `${formatMonth(viewStart)} · Week of ${viewStart.getDate()}`;
  const periodName = range === "Monthly" ? "month" : range === "Daily" ? "day" : "week";
  $("#prevWeek").setAttribute("aria-label", `Previous ${periodName}`);
  $("#nextWeek").setAttribute("aria-label", `Next ${periodName}`);

  $("#calendarView").classList.toggle("monthly-view", range === "Monthly");
  dateStripScroll.hidden = range === "Monthly";
  schedule.hidden = range === "Monthly";
  monthGrid.hidden = range !== "Monthly";

  if (range === "Monthly") {
    renderMonthGrid(monthGrid);
    return;
  }

  const gridWidth = days.length === 1 ? "100%" : "700px";
  dateStrip.style.minWidth = gridWidth;
  dateStrip.style.gridTemplateColumns = `62px repeat(${days.length}, minmax(82px, 1fr))`;
  dateStrip.innerHTML = `<span class="date-spacer" aria-hidden="true"></span>`;
  days.forEach(date => {
    const column = document.createElement("button");
    column.className = "date-column";
    if (sameDate(date, selectedDate)) column.classList.add("active");
    column.innerHTML = `<span>${weekdays[dayIndex(date)]}</span><strong>${String(date.getDate()).padStart(2, "0")}</strong>`;
    column.addEventListener("click", () => selectDate(date));
    dateStrip.appendChild(column);
  });

  renderSchedule(days);
}

function renderSchedule(days) {
  const grid = $("#scheduleGrid");
  const lastRow = 27;
  grid.innerHTML = "";
  grid.style.minWidth = days.length === 1 ? "100%" : "700px";
  grid.style.gridTemplateColumns = `62px repeat(${days.length}, minmax(82px, 1fr))`;
  for (let row = 1; row <= lastRow; row++) {
    const label = document.createElement("div");
    label.className = "time-label";
    label.style.gridRow = row;
    if (row % 2 === 1) label.textContent = timeText(420 + (row - 1) * 30);
    grid.appendChild(label);
  }

  days.forEach((date, index) => {
    const line = document.createElement("div");
    line.className = "day-line";
    line.style.gridColumn = index + 2;
    grid.appendChild(line);

    events.filter(item => eventOccursOnDate(item, date)).forEach(item => {
      const card = document.createElement("button");
      card.className = `event-card schedule-event ${item.color}`;
      card.style.gridColumn = index + 2;
      card.style.gridRow = `${Math.floor((item.start - 420) / 30) + 1} / span ${Math.max(1, Math.ceil((item.end - item.start) / 30))}`;
      const details = [item.instructor, `${timeText(item.start)}–${timeText(item.end)}`, item.location].filter(Boolean);
      card.innerHTML = `<strong>${escapeHTML(item.title)}</strong><span>${details.map(escapeHTML).join("<br>")}</span>`;
      card.addEventListener("click", () => openEventDialog(item));
      grid.appendChild(card);
    });
  });
  grid.style.height = "756px";
  $(".schedule-scroll").scrollLeft = 0;
  $("#dateStripScroll").scrollLeft = 0;
}

function renderMonthGrid(container) {
  const year = monthCursor.getFullYear();
  const month = monthCursor.getMonth();
  const first = new Date(year, month, 1);
  const start = new Date(first);
  start.setDate(1 - ((first.getDay() + 6) % 7));
  const firstOffset = (first.getDay() + 6) % 7;
  const count = Math.ceil((firstOffset + new Date(year, month + 1, 0).getDate()) / 7) * 7;
  const headers = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  container.innerHTML = `<div class="month-grid">${headers.map(day => `<div class="month-weekday">${day}</div>`).join("")}</div>`;
  const grid = container.firstElementChild;
  for (let index = 0; index < count; index++) {
    const date = dateAtOffset(start, index);
    const dayEvents = events.filter(item => eventOccursOnDate(item, date));
    const cell = document.createElement("button");
    cell.className = "month-day";
    if (date.getMonth() !== month) cell.classList.add("muted");
    if (sameDate(date, selectedDate)) cell.classList.add("selected");
    cell.innerHTML = `<strong>${date.getDate()}</strong><span>${dayEvents.length ? `${dayEvents.length} event${dayEvents.length > 1 ? "s" : ""}` : ""}</span>`;
    cell.addEventListener("click", () => {
      selectedDate = new Date(date);
      monthCursor = new Date(date.getFullYear(), date.getMonth(), 1);
      range = "Daily";
      updateRangeButtons();
      renderMiniCalendar();
      renderCalendar();
    });
    grid.appendChild(cell);
  }
}

function renderTasks() {
  const makeTaskRow = (task, index, extraClass = "") => {
    const row = document.createElement("div");
    row.className = `task-item ${extraClass}`;
    row.innerHTML = `<label class="check-row"><input type="checkbox" ${task.checked ? "checked" : ""}><span>${escapeHTML(task.title)}</span></label><button class="task-edit" aria-label="Edit ${escapeHTML(task.title)}" title="Edit task">✎</button>`;
    row.querySelector("input").addEventListener("change", event => {
      tasks[index].checked = event.target.checked;
      saveState();
      renderTasks();
    });
    row.querySelector(".task-edit").addEventListener("click", () => openTaskDialog(index));
    return row;
  };
  for (const [list, id] of [["my", "myTaskList"], ["other", "otherTaskList"]]) {
    const container = document.getElementById(id);
    container.innerHTML = "";
    tasks.forEach((task, index) => {
      if (task.list === list) container.appendChild(makeTaskRow(task, index));
    });
  }
  const allTasks = $("#allTasksList");
  allTasks.innerHTML = "";
  tasks.forEach((task, index) => {
    const row = makeTaskRow(task, index, "full-task-item");
    const listName = document.createElement("span");
    listName.className = "task-list-name";
    listName.textContent = task.list === "my" ? "My Calendar" : "Other Calendar";
    row.appendChild(listName);
    allTasks.appendChild(row);
  });
}

function renderInbox() {
  const container = $("#inboxList");
  container.innerHTML = "";
  const today = selectedDate;
  const todayEvents = events.filter(item => eventOccursOnDate(item, today)).sort((a, b) => a.start - b.start);
  if (!todayEvents.length) {
    container.innerHTML = `<p class="empty-state">No events scheduled for ${escapeHTML(today.toLocaleDateString("en-US", { weekday: "long" }))}.</p>`;
    return;
  }
  todayEvents.forEach(item => {
    const row = document.createElement("div");
    row.className = "inbox-item";
    row.innerHTML = `<span class="inbox-dot ${escapeHTML(item.color)}"></span><div><strong>${escapeHTML(item.title)}</strong><p>${timeText(item.start)}–${timeText(item.end)}${item.location ? ` · ${escapeHTML(item.location)}` : ""}</p></div>`;
    container.appendChild(row);
  });
}

function renderHeading() {
  const title = activePage === "dashboard" ? `Welcome back${settings.name ? `, ${settings.name.trim()}` : ""}`
    : activePage === "calendar" ? "Calendar"
    : activePage === "tasks" ? "Tasks"
      : activePage === "inbox" ? "Inbox"
        : activePage === "settings" ? "Settings"
          : settings.calendarTitle;
  $("#pageTitle").textContent = title;
  $("#welcomeEyebrow").hidden = activePage !== "dashboard";
  $("#pageSubtitle").textContent = activePage === "dashboard"
    ? "Take a breath, set your priorities, and make today yours."
    : activePage === "calendar" ? "Plan your classes and events."
      : activePage === "tasks" ? "Create, check off, and organize your tasks."
        : activePage === "inbox" ? "A quick look at what's coming up."
          : "Make your planner feel like yours.";
}

function showPage(page) {
  if (accountModeEnabled && !authSession && page !== "settings") return;
  activePage = page;
  $("#dashboardPage").hidden = !["dashboard", "calendar"].includes(page);
  $("#tasksPage").hidden = page !== "tasks";
  $("#inboxPage").hidden = page !== "inbox";
  $("#settingsPage").hidden = page !== "settings";
  $("#dashboardPage").classList.toggle("calendar-only", page === "calendar");
  $$("[data-page]").forEach(button => button.classList.toggle("active", button.dataset.page === page));
  renderHeading();
  if (page === "tasks") renderTasks();
  if (page === "inbox") renderInbox();
}

function updateRangeButtons() {
  $$(".view-switcher button").forEach(button => button.classList.toggle("active", button.dataset.range === range));
}

function openEventDialog(item = null) {
  editingEventIndex = item ? events.indexOf(item) : null;
  const form = eventForm;
  form.elements.title.value = item?.title || "";
  form.elements.instructor.value = item?.instructor || "";
  form.elements.location.value = item?.location || "";
  form.elements.day.value = String(item?.day ?? dayIndex(selectedDate));
  form.elements.frequency.value = item?.frequency || "weekly";
  form.elements.date.value = item?.date || dateString(selectedDate);
  form.elements.start.value = item ? `${String(Math.floor(item.start / 60)).padStart(2, "0")}:${String(item.start % 60).padStart(2, "0")}` : "09:00";
  form.elements.end.value = item ? `${String(Math.floor(item.end / 60)).padStart(2, "0")}:${String(item.end % 60).padStart(2, "0")}` : "10:00";
  form.elements.color.value = item?.color || "blue";
  $("#eventDialog").querySelector(".dialog-heading strong").textContent = item ? "Edit event" : "Add a new event";
  $("#saveEventButton").textContent = item ? "Save changes" : "Add Event";
  $("#deleteEventButton").hidden = !item;
  $("#eventDateField").hidden = form.elements.frequency.value !== "once";
  eventDialog.showModal();
}

function openTaskDialog(index = null, list = "my") {
  editingTaskIndex = index;
  const task = index === null ? null : tasks[index];
  taskForm.elements.title.value = task?.title || "";
  taskForm.elements.list.value = task?.list || list;
  $("#taskDialogTitle").textContent = task ? "Edit task" : "Add a task";
  $("#saveTaskButton").textContent = task ? "Save changes" : "Add task";
  $("#deleteTaskButton").hidden = !task;
  taskDialog.showModal();
}

function applySettings() {
  document.body.classList.toggle("dark", settings.theme === "dark");
  $("#themeLabel").textContent = settings.theme === "dark" ? "Dark" : "Light";
  $("#themeIcon")?.setAttribute("aria-label", settings.theme === "dark" ? "Dark mode" : "Light mode");
  document.documentElement.style.setProperty("--violet-dark", settings.accentColor);
  document.documentElement.style.setProperty("--accent", settings.accentColor);
  $("#avatarButton").textContent = settings.name ? settings.name.trim().split(/\s+/).map(part => part[0]).join("").slice(0, 2).toUpperCase() : "JD";
  $("#myCalendarTitle").textContent = settings.calendarTitle;
  $("#otherCalendarTitle").textContent = settings.otherCalendarTitle;
  const form = $("#settingsForm");
  form.elements.name.value = settings.name;
  form.elements.calendarTitle.value = settings.calendarTitle;
  form.elements.otherCalendarTitle.value = settings.otherCalendarTitle;
  form.elements.accentColor.value = settings.accentColor;
  form.elements.theme.value = settings.theme;
  for (const option of taskForm.elements.list.options) {
    option.textContent = option.value === "my" ? settings.calendarTitle : settings.otherCalendarTitle;
  }
}

$("#themeToggle").addEventListener("click", () => {
  settings.theme = settings.theme === "dark" ? "light" : "dark";
  applySettings();
  saveState();
});
$(".brand").addEventListener("click", () => showPage("dashboard"));
$("#addEventButton").addEventListener("click", () => openEventDialog());
eventForm.elements.frequency.addEventListener("change", () => {
  $("#eventDateField").hidden = eventForm.elements.frequency.value !== "once";
});
$("#eventForm").addEventListener("submit", event => {
  if (event.submitter?.value === "cancel") return;
  event.preventDefault();
  const form = event.currentTarget;
  const start = toMinutes(form.elements.start.value);
  const end = toMinutes(form.elements.end.value);
  if (start < 420 || end > 1200 || end <= start) {
    form.elements.end.setCustomValidity("Choose an end time after the start time, between 7:00 AM and 8:00 PM.");
    form.elements.end.reportValidity();
    form.elements.end.setCustomValidity("");
    return;
  }
  const frequency = form.elements.frequency.value;
  const date = frequency === "once" ? form.elements.date.value : "";
  if (frequency === "once" && !date) {
    form.elements.date.reportValidity();
    return;
  }
  const existing = editingEventIndex === null ? null : events[editingEventIndex];
  const item = {
    ...existing,
    id: existing?.id || createEventId(),
    title: form.elements.title.value.trim(),
    instructor: form.elements.instructor.value.trim(),
    location: form.elements.location.value.trim(),
    frequency,
    date,
    day: frequency === "once" ? dayIndex(new Date(`${date}T12:00:00`)) : Number(form.elements.day.value),
    start,
    end,
    color: form.elements.color.value
  };
  if (editingEventIndex === null) events.push(item);
  else events[editingEventIndex] = item;
  saveState();
  renderCalendar();
  renderInbox();
  eventDialog.close();
  form.reset();
  editingEventIndex = null;
  if (googleConnected) syncGoogleCalendar();
});
$("#deleteEventButton").addEventListener("click", () => {
  if (editingEventIndex === null) return;
  const [removed] = events.splice(editingEventIndex, 1);
  if (removed.googleEventId && !deletedGoogleEventIds.includes(removed.googleEventId)) {
    deletedGoogleEventIds.push(removed.googleEventId);
  }
  saveState();
  renderCalendar();
  renderInbox();
  eventDialog.close();
  if (googleConnected) syncGoogleCalendar();
});
function closeEventDialog() {
  eventDialog.close();
  eventForm.reset();
  editingEventIndex = null;
}
$("#closeEventDialog").addEventListener("click", closeEventDialog);
$("#cancelEventButton").addEventListener("click", closeEventDialog);

$("#taskForm").addEventListener("submit", event => {
  if (event.submitter?.value === "cancel") return;
  event.preventDefault();
  const item = { title: taskForm.elements.title.value.trim(), list: taskForm.elements.list.value };
  if (!item.title) return;
  if (editingTaskIndex === null) tasks.push({ ...item, checked: false });
  else tasks[editingTaskIndex] = { ...tasks[editingTaskIndex], ...item };
  saveState();
  renderTasks();
  taskDialog.close();
  taskForm.reset();
  editingTaskIndex = null;
});
$("#deleteTaskButton").addEventListener("click", () => {
  if (editingTaskIndex === null) return;
  tasks.splice(editingTaskIndex, 1);
  saveState();
  renderTasks();
  taskDialog.close();
});
function closeTaskDialog() {
  taskDialog.close();
  taskForm.reset();
  editingTaskIndex = null;
}
$("#closeTaskDialog").addEventListener("click", closeTaskDialog);
$("#cancelTaskButton").addEventListener("click", closeTaskDialog);

$("#addMyTask").addEventListener("click", () => openTaskDialog(null, "my"));
$("#addOtherTask").addEventListener("click", () => openTaskDialog(null, "other"));
$("#addTaskPageButton").addEventListener("click", () => openTaskDialog());
$$("[data-page]").forEach(button => button.addEventListener("click", () => showPage(button.dataset.page)));
$$(".view-switcher button").forEach(button => button.addEventListener("click", () => {
  range = button.dataset.range;
  updateRangeButtons();
  renderCalendar();
}));

function moveDate(amount) {
  if (range === "Monthly") {
    monthCursor = new Date(monthCursor.getFullYear(), monthCursor.getMonth() + amount, 1);
  } else if (range === "Daily") {
    selectedDate = dateAtOffset(selectedDate, amount);
    viewStart = startOfWeek(selectedDate);
    monthCursor = new Date(selectedDate.getFullYear(), selectedDate.getMonth(), 1);
  } else {
    viewStart = dateAtOffset(viewStart, amount * 7);
    selectedDate = new Date(viewStart);
    monthCursor = new Date(viewStart.getFullYear(), viewStart.getMonth(), 1);
  }
  renderMiniCalendar();
  renderCalendar();
  renderInbox();
}

$("#prevMonth").addEventListener("click", () => {
  monthCursor = new Date(monthCursor.getFullYear(), monthCursor.getMonth() - 1, 1);
  renderMiniCalendar();
  if (range === "Monthly") renderCalendar();
});
$("#nextMonth").addEventListener("click", () => {
  monthCursor = new Date(monthCursor.getFullYear(), monthCursor.getMonth() + 1, 1);
  renderMiniCalendar();
  if (range === "Monthly") renderCalendar();
});
$("#prevWeek").addEventListener("click", () => moveDate(-1));
$("#nextWeek").addEventListener("click", () => moveDate(1));
$("#todayButton").addEventListener("click", () => {
  selectedDate = new Date();
  viewStart = startOfWeek(selectedDate);
  monthCursor = new Date(selectedDate.getFullYear(), selectedDate.getMonth(), 1);
  renderMiniCalendar();
  renderCalendar();
  renderInbox();
});

$("#settingsForm").addEventListener("submit", event => {
  event.preventDefault();
  settings = {
    ...settings,
    name: event.currentTarget.elements.name.value.trim(),
    calendarTitle: event.currentTarget.elements.calendarTitle.value.trim() || "My Calendar",
    otherCalendarTitle: event.currentTarget.elements.otherCalendarTitle.value.trim() || "Other Calendar",
    accentColor: event.currentTarget.elements.accentColor.value,
    theme: event.currentTarget.elements.theme.value
  };
  applySettings();
  saveState();
  renderHeading();
});

function currentPlannerData() {
  return {
    events: events.map(item => ({ ...item })),
    tasks: tasks.map(item => ({ ...item })),
    deletedGoogleEventIds: [...deletedGoogleEventIds],
    settings: { ...settings }
  };
}

function applyPlannerData(saved, { persistLocal = true } = {}) {
  const data = normalizePlannerData(saved);
  applyingRemoteData = true;
  events = data.events.map((item, index) => ({ ...item, id: item.id || `timeframe-${index}-${Math.random().toString(36).slice(2, 8)}` }));
  tasks = data.tasks.map(item => ({ ...item }));
  deletedGoogleEventIds = [...data.deletedGoogleEventIds];
  settings = { name: "", calendarTitle: "My Calendar", otherCalendarTitle: "Other Calendar", accentColor: "#007aff", theme: "light", ...data.settings };
  applySettings();
  renderMiniCalendar();
  renderCalendar();
  renderTasks();
  renderInbox();
  renderHeading();
  if (persistLocal) saveState();
  applyingRemoteData = false;
}

async function supabaseRequest(path, { method = "GET", body, accessToken, headers = {} } = {}) {
  if (!supabaseConfigured) throw new Error("Add the Supabase project URL and anon key to supabase-config.js first.");
  const response = await fetch(`${supabaseUrl}${path}`, {
    method,
    headers: {
      apikey: supabaseAnonKey,
      Authorization: `Bearer ${accessToken || supabaseAnonKey}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...headers
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  const text = await response.text();
  let result = null;
  if (text) {
    try {
      result = JSON.parse(text);
    } catch {
      throw new Error("Supabase returned an unreadable response.");
    }
  }
  if (!response.ok) {
    const error = new Error(result?.msg || result?.message || result?.error_description || result?.error?.message || result?.error || `Supabase request failed (${response.status}).`);
    error.status = response.status;
    throw error;
  }
  return result;
}

function storeAuthSession(session) {
  const expiresAt = Number(session.expires_at) || Math.floor(Date.now() / 1000) + Number(session.expires_in || 3600);
  authSession = { ...session, expires_at: expiresAt };
  localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(authSession));
}

async function getValidAuthSession() {
  if (!authSession) throw new Error("Sign in to sync this planner.");
  if (Number(authSession.expires_at || 0) * 1000 > Date.now() + 60000) return authSession;
  let refreshed;
  try {
    refreshed = await supabaseRequest("/auth/v1/token?grant_type=refresh_token", {
      method: "POST",
      body: { refresh_token: authSession.refresh_token }
    });
  } catch (error) {
    if ([400, 401, 403].includes(error.status)) {
      authSession = null;
      localStorage.removeItem(AUTH_STORAGE_KEY);
      cloudSyncReady = false;
      activePage = "settings";
      showPage("settings");
      updateAccountUI("Your sign-in expired. Sign in again to continue syncing.");
    }
    throw error;
  }
  if (!refreshed?.access_token || !refreshed?.refresh_token || !refreshed?.user?.id) {
    throw new Error("Supabase did not return a valid refreshed session. Please sign in again.");
  }
  storeAuthSession(refreshed);
  updateAccountUI();
  return authSession;
}

function updateAccountUI(message = "") {
  const signedIn = Boolean(authSession?.user?.id);
  const accountLocked = accountModeEnabled && !signedIn;
  $(".app-shell").classList.toggle("account-loading", accountActivationInProgress);
  const status = $("#accountStatus");
  if (message) status.textContent = message;
  else if (!supabaseConfigured) status.textContent = "Add your Supabase project URL and anon key in supabase-config.js to enable user accounts and cloud sync.";
  else if (signedIn) status.textContent = `Signed in as ${authSession.user.email || "your account"}. Planner data syncs to this account.`;
  else if (accountLocked) status.textContent = "Signed out. Sign in to open a private planner on this device.";
  else status.textContent = "Using the guest planner on this device. Sign in for a private planner that follows your account.";

  $("#accountForm").hidden = signedIn;
  $("#settingsForm").hidden = accountLocked;
  $("#signOutButton").hidden = !signedIn;
  $("#importLocalOption").hidden = signedIn || accountModeEnabled || !supabaseConfigured;
  $("#signInButton").disabled = !supabaseConfigured;
  $("#signUpButton").disabled = !supabaseConfigured;
  $("#googleSyncPanel").hidden = !signedIn || !supabaseConfigured;
  $("#addEventButton").disabled = accountLocked;
  $("#themeToggle").disabled = accountLocked;
  $$("[data-page]").forEach(button => { button.disabled = accountLocked && button.dataset.page !== "settings"; });
  $$(".view-switcher button").forEach(button => { button.disabled = accountLocked; });
  $("#avatarButton").textContent = settings.name
    ? settings.name.trim().split(/\s+/).map(part => part[0]).join("").slice(0, 2).toUpperCase()
    : signedIn ? String(authSession.user.email || "U").slice(0, 1).toUpperCase() : "JD";
}

async function getRemotePlannerData() {
  const session = await getValidAuthSession();
  const query = new URLSearchParams({ select: "data,updated_at", user_id: `eq.${session.user.id}` });
  const rows = await supabaseRequest(`/rest/v1/planner_data?${query}`, { accessToken: session.access_token });
  if (!Array.isArray(rows)) throw new Error("Supabase returned an invalid planner record.");
  return rows[0] || null;
}

async function writeRemotePlannerData(data) {
  const session = await getValidAuthSession();
  const rows = await supabaseRequest("/rest/v1/planner_data?on_conflict=user_id", {
    method: "POST",
    accessToken: session.access_token,
    headers: { Prefer: "resolution=merge-duplicates,return=representation" },
    body: { user_id: session.user.id, data }
  });
  return Array.isArray(rows) ? rows[0] || null : null;
}

async function activateAccount(session, guestData, importGuestData) {
  if (accountActivationInProgress) return;
  accountActivationInProgress = true;
  try {
    if (!session?.access_token || !session?.refresh_token || !session?.user?.id) {
      throw new Error("Supabase did not return a valid account session.");
    }
    const localKey = accountStorageKey(session.user.id);
    const preserveLocalChanges = cloudDirty && authSession?.user?.id === session.user.id && activeStorageKey === localKey;
    const cachedData = localStorage.getItem(localKey) ? readSavedState(localKey) : null;
    const starterData = importGuestData ? normalizePlannerData(guestData) : cachedData || normalizePlannerData({});
    storeAuthSession(session);
    accountModeEnabled = true;
    localStorage.setItem(ACCOUNT_MODE_KEY, "required");
    activeStorageKey = localKey;
    cloudSyncReady = false;
    cloudDirty = preserveLocalChanges;
    cloudLoadFailed = false;
    clearTimeout(cloudSaveTimer);
    applyPlannerData(starterData);
    const startingSnapshot = JSON.stringify(currentPlannerData());
    updateAccountUI(`Signed in as ${session.user.email || "your account"}. Loading your private planner…`);

    try {
      const remote = await getRemotePlannerData();
      const localChangedDuringLoad = JSON.stringify(currentPlannerData()) !== startingSnapshot;
      if (remote) {
        lastRemoteUpdatedAt = remote.updated_at || "";
        if (preserveLocalChanges || localChangedDuringLoad) cloudDirty = true;
        else applyPlannerData(remote.data);
      } else {
        const saved = await writeRemotePlannerData(starterData);
        lastRemoteUpdatedAt = saved?.updated_at || new Date().toISOString();
        if (localChangedDuringLoad) cloudDirty = true;
      }
      cloudSyncReady = true;
      cloudLoadFailed = false;
      updateAccountUI();
      if (cloudDirty) scheduleCloudSave();
    } catch (error) {
      cloudLoadFailed = true;
      updateAccountUI(`Signed in locally, but cloud sync failed: ${error.message}`);
      console.error("Could not load this user's planner from Supabase.", error);
    }
    await updateGoogleStatus();
  } finally {
    accountActivationInProgress = false;
    $(".app-shell").classList.remove("account-loading");
  }
}

async function authenticateAccount(action) {
  if (!supabaseConfigured) {
    updateAccountUI();
    return;
  }
  const form = $("#accountForm");
  if (!form.reportValidity()) return;
  const buttons = [$("#signInButton"), $("#signUpButton")];
  buttons.forEach(button => { button.disabled = true; });
  const guestData = currentPlannerData();
  updateAccountUI(action === "signup" ? "Creating your account…" : "Signing in…");
  try {
    const endpoint = action === "signup" ? "/auth/v1/signup" : "/auth/v1/token?grant_type=password";
    const result = await supabaseRequest(endpoint, {
      method: "POST",
      body: { email: form.elements.email.value.trim(), password: form.elements.password.value }
    });
    const session = result?.session || (result?.access_token ? result : null);
    if (!session) {
      if (action !== "signup") throw new Error("Supabase did not return a sign-in session.");
      updateAccountUI("Account created. Check your email to confirm it, then sign in.");
      return;
    }
    await activateAccount(session, guestData, $("#importLocalData").checked);
    form.reset();
  } catch (error) {
    updateAccountUI(error.message);
    console.error(`Could not ${action === "signup" ? "create" : "sign in to"} the account.`, error);
  } finally {
    buttons.forEach(button => { button.disabled = !supabaseConfigured || Boolean(authSession); });
  }
}

$("#accountForm").addEventListener("submit", event => {
  event.preventDefault();
  authenticateAccount("signin");
});
$("#signUpButton").addEventListener("click", () => authenticateAccount("signup"));
$("#avatarButton").addEventListener("click", () => showPage("settings"));

$("#signOutButton").addEventListener("click", async () => {
  if (!authSession) return;
  clearTimeout(cloudSaveTimer);
  if (cloudDirty) await persistCloudData();
  const session = authSession;
  let message = "";
  try {
    await supabaseRequest("/auth/v1/logout?scope=local", { method: "POST", accessToken: session.access_token });
  } catch (error) {
    message = `Signed out on this device; remote sign-out reported: ${error.message}`;
    console.error("Supabase sign-out request failed.", error);
  }
  authSession = null;
  localStorage.removeItem(AUTH_STORAGE_KEY);
  activeStorageKey = STORAGE_KEY;
  cloudSyncReady = false;
  cloudDirty = false;
  lastRemoteUpdatedAt = "";
  accountModeEnabled = true;
  localStorage.setItem(ACCOUNT_MODE_KEY, "required");
  activePage = "settings";
  applyPlannerData({}, { persistLocal: false });
  showPage("settings");
  updateAccountUI(message);
  await updateGoogleStatus();
});

async function persistCloudData() {
  if (!authSession || !cloudSyncReady || !cloudDirty || cloudSaveInProgress) return;
  cloudSaveInProgress = true;
  cloudDirty = false;
  const userId = authSession.user.id;
  const data = currentPlannerData();
  try {
    const saved = await writeRemotePlannerData(data);
    if (authSession?.user?.id === userId) {
      lastRemoteUpdatedAt = saved?.updated_at || new Date().toISOString();
      updateAccountUI();
    }
  } catch (error) {
    cloudDirty = true;
    updateAccountUI(`Cloud save failed: ${error.message}`);
    console.error("Could not save this user's planner to Supabase.", error);
  } finally {
    cloudSaveInProgress = false;
    if (cloudDirty && authSession?.user?.id === userId) {
      clearTimeout(cloudSaveTimer);
      cloudSaveTimer = setTimeout(persistCloudData, 5000);
    }
  }
}

function scheduleCloudSave() {
  if (!authSession || !cloudSyncReady) return;
  cloudDirty = true;
  clearTimeout(cloudSaveTimer);
  cloudSaveTimer = setTimeout(persistCloudData, 800);
}

async function pollCloudPlanner() {
  if (!authSession || document.hidden || accountActivationInProgress) return;
  if (!cloudSyncReady) {
    await activateAccount(authSession, readSavedState(activeStorageKey), false);
    return;
  }
  if (cloudDirty || cloudSaveInProgress || cloudSaveTimer) return;
  const localSnapshot = JSON.stringify(currentPlannerData());
  try {
    const remote = await getRemotePlannerData();
    if (remote?.updated_at && remote.updated_at !== lastRemoteUpdatedAt) {
      if (cloudDirty || cloudSaveInProgress || cloudSaveTimer || JSON.stringify(currentPlannerData()) !== localSnapshot) return;
      lastRemoteUpdatedAt = remote.updated_at;
      applyPlannerData(remote.data);
      updateAccountUI();
    }
  } catch (error) {
    updateAccountUI(`Cloud sync paused: ${error.message}`);
    console.error("Could not check for planner updates.", error);
  }
}

async function updateGoogleStatus() {
  const status = $("#googleSyncStatus");
  if (!authSession || !supabaseConfigured) {
    googleConnected = false;
    $("#googleConnectButton").disabled = true;
    $("#googleSyncButton").hidden = true;
    $("#googleDisconnectButton").hidden = true;
    status.textContent = "Sign in to connect your personal Google Calendar.";
    return;
  }
  try {
    const session = await getValidAuthSession();
    const response = await fetch(`${googleApiBase}/api/google/status`, {
      headers: { Authorization: `Bearer ${session.access_token}` }
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Could not read Google Calendar status.");
    googleConnected = data.connected;
    $("#googleConnectButton").disabled = !data.configured || data.connected;
    $("#googleConnectButton").hidden = data.connected;
    $("#googleSyncButton").hidden = !data.connected;
    $("#googleDisconnectButton").hidden = !data.connected;
    status.textContent = data.connected
      ? `Connected to ${data.calendarName}. Last sync: ${data.lastSync ? new Date(data.lastSync).toLocaleTimeString() : "not synced yet"}.`
      : data.configured
        ? "Not connected. Connect your Google account to sync."
        : "OAuth is not configured. Follow the Google setup steps in README.md.";
  } catch (error) {
    googleConnected = false;
    $("#googleConnectButton").disabled = false;
    $("#googleSyncButton").hidden = true;
    $("#googleDisconnectButton").hidden = true;
    status.textContent = `Google Calendar service unavailable: ${error.message}`;
    console.error("Could not check this user's Google Calendar status.", error);
  }
}

async function syncGoogleCalendar() {
  if (!authSession || !googleConnected || googleSyncInProgress) return;
  googleSyncInProgress = true;
  $("#addEventButton").disabled = true;
  $$(".schedule-event").forEach(card => { card.disabled = true; });
  $("#googleSyncStatus").textContent = "Syncing…";
  try {
    const session = await getValidAuthSession();
    const response = await fetch(`${googleApiBase}/api/google/sync`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
      body: JSON.stringify({ events, deletedGoogleEventIds, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Google Calendar sync failed.");
    events = data.events;
    deletedGoogleEventIds = data.deletedGoogleEventIds || [];
    saveState();
    renderCalendar();
    renderInbox();
    const skipped = data.unsupported ? ` Skipped ${data.unsupported} unsupported Google event${data.unsupported === 1 ? "" : "s"}.` : "";
    $("#googleSyncStatus").textContent = `Synced with ${data.calendarName} at ${new Date(data.lastSync).toLocaleTimeString()}.${skipped}`;
  } catch (error) {
    console.error("This user's Google Calendar sync failed.", error);
    await updateGoogleStatus();
    $("#googleSyncStatus").textContent = googleConnected
      ? `Sync failed: ${error.message}`
      : `Google connection needs attention: ${error.message}`;
  } finally {
    googleSyncInProgress = false;
    $("#addEventButton").disabled = false;
    $$(".schedule-event").forEach(card => { card.disabled = false; });
  }
}

$("#googleConnectButton").addEventListener("click", async () => {
  googlePopup = window.open("about:blank", "timeframe-google-auth", "width=540,height=720");
  if (!googlePopup) {
    $("#googleSyncStatus").textContent = "Allow pop-ups to connect Google Calendar.";
    return;
  }
  try {
    const session = await getValidAuthSession();
    const response = await fetch(`${googleApiBase}/auth/google/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
      body: JSON.stringify({ origin: location.origin, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Could not start Google sign-in.");
    googlePopup.location = data.authorizationUrl;
  } catch (error) {
    googlePopup.close();
    googlePopup = null;
    $("#googleSyncStatus").textContent = error.message;
    console.error("Could not start this user's Google Calendar authorization.", error);
  }
});
window.addEventListener("message", event => {
  if (event.source !== googlePopup || event.origin !== new URL(googleApiBase).origin) return;
  googlePopup = null;
  if (event.data?.type === "google-calendar-error") {
    $("#googleSyncStatus").textContent = `Google sign-in failed: ${event.data.error}`;
    return;
  }
  if (event.data?.type !== "google-calendar-connected") return;
  updateGoogleStatus().then(() => syncGoogleCalendar());
});
$("#googleSyncButton").addEventListener("click", syncGoogleCalendar);
$("#googleDisconnectButton").addEventListener("click", async () => {
  try {
    const session = await getValidAuthSession();
    const response = await fetch(`${googleApiBase}/api/google/disconnect`, {
      method: "POST",
      headers: { Authorization: `Bearer ${session.access_token}` }
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Could not disconnect Google Calendar.");
    googleConnected = false;
    await updateGoogleStatus();
    if (!data.revoked) {
      $("#googleSyncStatus").textContent = "Disconnected here, but Google did not confirm token revocation. Remove TimeFrame Planner in your Google Account permissions.";
    }
  } catch (error) {
    $("#googleSyncStatus").textContent = error.message;
    console.error("Could not disconnect Google Calendar.", error);
  }
});

$(".schedule-scroll").addEventListener("scroll", event => {
  $("#dateStripScroll").scrollLeft = event.currentTarget.scrollLeft;
});
$("#dateStripScroll").addEventListener("scroll", event => {
  $(".schedule-scroll").scrollLeft = event.currentTarget.scrollLeft;
});

applySettings();
renderMiniCalendar();
renderCalendar();
renderTasks();
renderHeading();
if (accountModeEnabled && !authSession) showPage("settings");
else saveState();
updateAccountUI();
if (authSession && supabaseConfigured) {
  activateAccount(authSession, readSavedState(activeStorageKey), false);
} else {
  updateGoogleStatus();
}
window.setInterval(() => {
  if (authSession) pollCloudPlanner();
}, 30000);
window.setInterval(() => {
  if (authSession && googleConnected && !document.hidden && !eventDialog.open) syncGoogleCalendar();
}, 60000);
