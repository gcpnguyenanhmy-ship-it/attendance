/* ===================== CẤU HÌNH ===================== */
// Dán URL web app của Apps Script (dạng https://script.google.com/macros/s/.../exec)
const API_URL =
  "https://script.google.com/macros/s/AKfycbzXAcz6OsXqN8xsP-LMebtHGKI_yn6PfH0PPfLK05xr2YFf_DPEiZBMk30wnhgJo2iV/exec";
// Muốn tự host model: tải thư mục model về cùng chỗ với index.html rồi đổi thành 'model/'
const MODEL_URL =
  "https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1.7.13/model/";
const THRESHOLD = 0.4; // nếu báo "Không nhận ra khuôn mặt" nhiều, thử 0.55 - 0.6
const TZ = "Asia/Ho_Chi_Minh";
// true: luôn dùng TinyFaceDetector (nhanh hơn nhiều trên tablet/điện thoại). false: dùng SSD khi có WebGL.
const FORCE_TINY = true;
const WARMUP_MS = 300; // chờ trước lần quét đầu tiên (để camera ổn định phơi sáng/lấy nét). Trước đây: 700
const SCAN_GAP_MS = 100; // nghỉ giữa hai lần quét khi chấm công. Trước đây: 350
/* ==================================================== */

let employees = []; // {id, name, desc, status: {type,time} | null}
let ready = false;
let stream = null;
let scanToken = 0; // đổi số này để hủy các vòng quét đang chạy
let lastAction = null;
let autoClose = null;

// Bộ phát hiện mặt: tạo trong loadFaceModels() sau khi tải model (SSD nếu có WebGL và FORCE_TINY=false, ngược lại Tiny)
let DET_OPTS = null;
let DET_NAME = "ssd";

const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errText = (e) =>
  String((e && e.message) || e).replace(/^Error:\s*/, "");

/* ---------- Mã thiết bị (token) ---------- */
const TOKEN_KEY = "chamcong_token";
let memToken = "";
const getToken = () => {
  if (memToken) return memToken;
  try {
    return localStorage.getItem(TOKEN_KEY) || "";
  } catch (e) {
    return "";
  }
};
const setToken = (t) => {
  memToken = t;
  try {
    localStorage.setItem(TOKEN_KEY, t);
  } catch (e) {}
};
const clearToken = () => {
  memToken = "";
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch (e) {}
};

function askToken(msg) {
  return new Promise((resolve) => {
    $("tokMsg").textContent = msg || "";
    $("tokInput").value = "";
    if (!$("tokDlg").open) $("tokDlg").showModal();
    $("tokForm").onsubmit = (ev) => {
      ev.preventDefault();
      const v = $("tokInput").value.trim();
      if (!v) return;
      setToken(v);
      $("tokDlg").close();
      resolve();
    };
  });
}
$("tokDlg").addEventListener("cancel", (ev) => ev.preventDefault()); // không cho đóng bằng phím Esc

/* ---------- Gọi Apps Script ---------- */
async function apiTimed(action, data = {}) {
  const tReq = performance.now();
  let res;
  try {
    res = await fetch(API_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" }, // tránh preflight CORS
      body: JSON.stringify({ token: getToken(), action, ...data }),
    });
  } catch (e) {
    const err = new Error("Can not connect to the server.");
    err.code = "NETWORK";
    throw err;
  }
  let j;
  try {
    j = await res.json();
  } catch (e) {
    const err = new Error(
      'The server returned an invalid response. Check that the Apps Script web app access is set to "Anyone".',
    );
    err.code = "NETWORK";
    throw err;
  }
  if (!j.ok) {
    if (j.error === "UNAUTHORIZED") {
      clearToken();
      const err = new Error("Incorrect Device ID. Please try again");
      err.code = "UNAUTHORIZED";
      throw err;
    }
    const err = new Error(j.error || "Unknown error.");
    err.code = "SERVER";
    throw err;
  }
  // rtMs: tổng thời gian khứ hồi; serverMs: thời gian chạy bên trong Apps Script (backend trả về)
  return {
    data: j.data,
    rtMs: Math.round(performance.now() - tReq),
    serverMs: typeof j.serverMs === "number" ? j.serverMs : null,
  };
}
const api = async (action, data) => (await apiTimed(action, data)).data;

/* ---------- Giữ màn hình luôn sáng (cho tablet) ---------- */
async function keepAwake() {
  try {
    if ("wakeLock" in navigator)
      await navigator.wakeLock.request("screen");
  } catch (e) {}
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") keepAwake();
});
keepAwake();

/* ---------- Đồng hồ ---------- */
function tick() {
  const now = new Date();
  $("clock").textContent = now.toLocaleTimeString("en-US", {
    timeZone: TZ,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });
  $("date").textContent = now.toLocaleDateString("en-GB", {
    timeZone: TZ,
    weekday: "short",
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}
setInterval(tick, 1000);
tick();

/* ---------- Danh sách ---------- */
function render(flashId) {
  const ul = $("list");
  ul.textContent = "";
  employees.forEach((e) => {
    const li = document.createElement("li");
    li.className =
      "row" +
      (e.id === flashId ? " flash" : "") +
      (pcEmp && e.id === pcEmp.id ? " sel" : "");

    const av = document.createElement("span");
    av.className = "avatar";
    av.textContent = e.name
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((w) => w[0])
      .join("")
      .toUpperCase();
    li.appendChild(av);

    const nm = document.createElement("span");
    nm.className = "name";
    nm.textContent = e.name;
    li.appendChild(nm);

    if (e.status) {
      const st = document.createElement("span");
      const isIn = e.status.type === "IN";
      st.className = "st " + (isIn ? "in" : "out");
      st.textContent =
        (isIn ? "In " : "Out ") + e.status.time.slice(0, 5);
      li.appendChild(st);
    }
    li.addEventListener("click", () => openPanel(e));
    ul.appendChild(li);
  });
  $("listNote").hidden = employees.length > 0;
  if (!employees.length) $("listNote").textContent = "No members yet.";
}
function applyStatuses(map) {
  employees.forEach((e) => (e.status = map[e.id] || null));
  applyPending();
  render();
}
// Cập nhật danh sách theo M_Employee: thêm người mới, đổi tên, bỏ người đã xoá, cập nhật trạng thái.
// Giữ nguyên dữ liệu khuôn mặt đã tải. Trả về true nếu cần tải lại vector (có người mới đã có mặt / mặt bị đổi).
function syncRoster(list) {
  const old = new Map(employees.map((e) => [e.id, e]));
  let needFull = false;
  employees = list.map((r) => {
    const e = old.get(r.id) || { id: r.id, descs: [], face: 0 };
    e.name = r.name;
    e.status = r.status;
    if ((r.face || 0) !== (e.face || 0)) needFull = true;
    return e;
  });
  applyPending();
  render();
  return needFull;
}
const anyDialogOpen = () =>
  $("scanDlg").open ||
  $("tokDlg").open ||
  $("pinDlg").open ||
  $("ovwDlg").open;
let rosterBusy = false;
async function refreshRoster() {
  if (rosterBusy || anyDialogOpen()) return;
  rosterBusy = true;
  try {
    const list = await api("getRoster");
    if (anyDialogOpen()) return; // người dùng vừa mở hộp thoại trong lúc chờ: bỏ lượt này
    if (syncRoster(list)) {
      await loadData();
      if (!anyDialogOpen()) render();
    }
  } catch (e) {
  } finally {
    rosterBusy = false;
  }
}
// Dữ liệu khuôn mặt có thể là 1 vector (dạng cũ) hoặc nhiều vector (dạng mới, mỗi góc mặt một vector)
const parseDescs = (s) => {
  const a = JSON.parse(s);
  return (Array.isArray(a[0]) ? a : [a]).map((v) => new Float32Array(v));
};
async function loadData() {
  const list = await api("getEmployees");
  employees = list.map((e) => ({
    id: e.id,
    name: e.name,
    status: e.status,
    descs: e.desc ? parseDescs(e.desc) : [], // chưa đăng ký mặt thì không có mẫu
    face: e.face || 0, // phiên bản dữ liệu mặt trên server (để phát hiện thay đổi)
  }));
  applyPending(); // giữ lại trạng thái tạm của các lần chấm công chưa kịp đồng bộ
}

/* ---------- Camera ---------- */
const videoReady = (v) => v.readyState >= 2 && v.videoWidth > 0;

async function startCamera() {
  stopCamera();
  stream = await navigator.mediaDevices.getUserMedia({
    video: {
      facingMode: "user",
      width: { ideal: 640 },
      height: { ideal: 480 },
    },
    audio: false,
  });
  const v = $("v");
  v.srcObject = stream;
  // đợi tới khi có khung hình thật (tối đa 5 giây)
  await Promise.race([
    new Promise((res) => {
      if (videoReady(v)) res();
      else v.onloadeddata = () => res();
    }),
    sleep(5000),
  ]);
  try {
    await v.play();
  } catch (e) {}
}
function stopCamera() {
  if (stream) {
    stream.getTracks().forEach((t) => t.stop());
    stream = null;
  }
  $("v").srcObject = null;
}
const cameraReason = () =>
  window.isSecureContext
    ? "Unable to start the camera. Please allow camera access."
    : "This page must be served over HTTPS to use the camera.";

/* ---------- Hộp thoại quét ---------- */
function openScan(title, hint) {
  clearTimeout(autoClose);
  $("camTitle").textContent = title;
  $("camHint").textContent = hint;
  $("camView").hidden = false;
  $("resView").hidden = true;
  if (!$("scanDlg").open) $("scanDlg").showModal();
}
function closeScan() {
  if ($("scanDlg").open) $("scanDlg").close();
}
function setActiveBtn(type) {
  $("btnIn").classList.toggle("active", type === "IN");
  $("btnOut").classList.toggle("active", type === "OUT");
}
$("scanDlg").addEventListener("close", () => {
  scanToken++;
  clearTimeout(autoClose);
  stopCamera();
  setActiveBtn(null);
});
$("cancel").addEventListener("click", closeScan);
$("done").addEventListener("click", closeScan);
$("retry").addEventListener("click", () => lastAction && lastAction());

const ICON_OK = (c) =>
  `<svg viewBox="0 0 88 88" aria-hidden="true"><circle cx="44" cy="44" r="41" fill="none" stroke="var(--${c})" stroke-width="2.5"/><path class="tick" d="M27 46 L39 58 L62 32" fill="none" stroke="var(--${c})" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const ICON_FAIL = `<svg viewBox="0 0 88 88" aria-hidden="true"><circle cx="44" cy="44" r="41" fill="none" stroke="var(--fail)" stroke-width="2.5"/><path class="tick" d="M30 30 L58 58 M58 30 L30 58" fill="none" stroke="var(--fail)" stroke-width="4" stroke-linecap="round"/></svg>`;

function showResult(r) {
  // r = {ok, kind: 'in'|'out', title, sub}
  stopCamera();
  $("camView").hidden = true;
  $("resView").hidden = false;
  $("res").className = "res " + (r.ok ? r.kind : "fail");
  $("resIcon").innerHTML = r.ok ? ICON_OK("green") : ICON_FAIL;
  $("resTitle").textContent = r.title;
  $("resSub").textContent = r.sub;
  $("retry").hidden = r.ok;
  $("resBtns").style.gridTemplateColumns = r.ok ? "1fr" : "1fr 1fr";
  $("done").className = r.ok ? "quiet" : "ghost";
  $("done").textContent = "Close";
  clearTimeout(autoClose);
  if (r.ok) autoClose = setTimeout(closeScan, 2600);
}

/* ---------- Nhận diện ---------- */
async function detectFull() {
  // trả về { descriptor, landmarks, ... } hoặc null
  const v = $("v");
  if (!videoReady(v)) return null;
  const r = await faceapi
    .detectSingleFace(v, DET_OPTS)
    .withFaceLandmarks()
    .withFaceDescriptor();
  return r || null;
}
async function getDescriptor() {
  const r = await detectFull();
  return r ? r.descriptor : null;
}
// Trả về người gần nhất và khoảng cách tới họ (dù có vượt THRESHOLD hay không)
function bestMatch(d) {
  let best = null,
    bestDist = 9;
  employees.forEach((e) => {
    // khoảng cách tới một nhân viên = góc mặt gần nhất trong các mẫu đã lưu
    let dist = 9;
    e.descs.forEach((v) => {
      const x = faceapi.euclideanDistance(d, v);
      if (x < dist) dist = x;
    });
    if (dist < bestDist) {
      bestDist = dist;
      best = e;
    }
  });
  return { emp: best, dist: bestDist };
}
function matchEmployee(d) {
  const m = bestMatch(d);
  return m.dist <= THRESHOLD ? m.emp : null;
}
// Thử nhận diện tối đa 10 giây; cần khớp cùng một người 2 lần liên tiếp mới chấp nhận
async function recognise(token) {
  const t0 = performance.now();
  let seenFace = false,
    streakId = null,
    streak = 0;
  await sleep(WARMUP_MS);
  while (performance.now() - t0 < 10000) {
    if (token !== scanToken) return { cancelled: true };

    const d = await getDescriptor();
    if (d) {
      seenFace = true;
      const m = bestMatch(d);
      const emp = m.dist <= THRESHOLD ? m.emp : null;
      if (emp) {
        streak = emp.id === streakId ? streak + 1 : 1;
        streakId = emp.id;
        if (streak >= 2) return { emp };
      } else {
        streak = 0;
        streakId = null;
      }
    }
    await sleep(SCAN_GAP_MS);
  }
  return { error: seenFace ? "unknown" : "noface" };
}
const REASON = {
  noface: "No face detected.",
  unknown: "Face not registered.",
};

/* ---------- Check in / Check out ---------- */
async function doCheck(type) {
  setActiveBtn(type);
  const label = type === "IN" ? "Check in" : "Check out";
  const token = ++scanToken;
  lastAction = () => doCheck(type);
  openScan(label, "Look straight at the camera.");

  try {
    await startCamera();
    if (token !== scanToken) return stopCamera();
  } catch (e) {
    return showResult({
      ok: false,
      title: label + " Fail",
      sub: cameraReason(),
    });
  }

  try {
    const res = await recognise(token);
    if (res.cancelled || token !== scanToken) return;
    if (res.error) {
      return showResult({
        ok: false,
        title: label + " Fail",
        sub: REASON[res.error],
      });
    }

    // Không chờ máy chủ: kiểm tra nhanh bằng trạng thái đã tải, hiện kết quả ngay, rồi ghi nhận ở nền.
    // Máy chủ vẫn là nơi quyết định cuối cùng; nếu khác kết quả đã hiện thì báo muộn (xem applyServerResult).
    const known = employees.find((x) => x.id === res.emp.id);
    const st = known && known.status;
    if (st && st.type === type) {
      // trùng loại với lần gần nhất hôm nay
      return handleLog(res.emp, type, label, {
        status: "SAME",
        time: st.time,
      });
    }
    if (!st && type === "OUT") {
      // check out khi hôm nay chưa check in
      return handleLog(res.emp, type, label, { status: "NO_IN" });
    }
    if (st && st.type === "OUT" && type === "IN") {
      return handleLog(res.emp, type, label, {
        status: "DONE_OUT",
        time: st.time,
      });
    }
    handleLog(res.emp, type, label, {
      status: "OK",
      time: localTime(Date.now()),
    });
    enqueueCheck(res.emp, type);
  } catch (e) {
    showResult({ ok: false, title: label + " Fail", sub: errText(e) });
  }
}

function handleLog(emp, type, label, r) {
  const done = type === "IN" ? "checked in" : "checked out";
  const fail = (sub) =>
    showResult({ ok: false, title: label + " Fail", sub });
  if (r.status === "OK") {
    const e = employees.find((x) => x.id === emp.id);
    if (e) e.status = { type, time: r.time };
    render(emp.id);
    return showResult({
      ok: true,
      kind: type === "IN" ? "in" : "out",
      title: label + " Success",
      sub: emp.name + " · " + r.time,
    });
  }
  if (r.status === "SAME")
    return fail(`${emp.name} already ${done} at ${r.time}.`);
  if (r.status === "NO_IN")
    return fail(`${emp.name} has not checked in today.`);
  if (r.status === "DONE_OUT")
    return fail(
      `${emp.name} already checked out at ${r.time}. \n Cannot check in again today.`,
    );
  if (r.status === "UNKNOWN")
    return fail("Member not found in the list.");
  fail("Unable to record the attendance.");
}

$("btnIn").addEventListener("click", () => doCheck("IN"));
$("btnOut").addEventListener("click", () => doCheck("OUT"));

/* ---------- Chấm công bằng PIN ---------- */
let pcEmp = null,
  pcBuf = "",
  pcBusy = false,
  pcAct = null; // chức năng đã chọn trước khi nhập PIN: "IN" | "OUT" | "FACE"
const PC_LABEL = { IN: "Clock in", OUT: "Clock out", FACE: "register face" };

function pcRefresh() {
  $("pcSub").textContent = pcEmp ? pcEmp.name : "";
  [...$("pcDots").children].forEach((d, i) =>
    d.classList.toggle("on", i < pcBuf.length),
  );
  // Clock in / Clock out / icon khuôn mặt sáng sẵn ngay khi mở hộp PIN (chọn chức năng trước, nhập PIN sau)
  $("pcIn").disabled = pcBusy;
  $("pcOut").disabled = pcBusy;
  $("pcFace").disabled = pcBusy || !ready;
  $("pcIn").classList.toggle("chosen", pcAct === "IN");
  $("pcOut").classList.toggle("chosen", pcAct === "OUT");
  $("pcFace").classList.toggle("chosen", pcAct === "FACE");
  // Đã chọn một chức năng thì hai nút còn lại tối đi (vẫn bấm được để đổi lựa chọn)
  $("pcIn").classList.toggle("dim", !!pcAct && pcAct !== "IN");
  $("pcOut").classList.toggle("dim", !!pcAct && pcAct !== "OUT");
  $("pcFace").classList.toggle("dim", !!pcAct && pcAct !== "FACE");
  // Làm mờ ô nhập PIN (4 chấm + bàn phím) và khóa không cho bấm cho tới khi chọn một nút chức năng
  $("pcDots").classList.toggle("locked", !pcAct);
  $("pcKeys").classList.toggle("locked", !pcAct);
  $("pcKeys")
    .querySelectorAll("button")
    .forEach((b) => (b.disabled = !pcAct));
}
function pcSay(t, err) {
  $("pcMsg").textContent = t || "";
  $("pcMsg").className = "hint" + (err ? " err" : "");
}
function openPanel(emp) {
  pcEmp = emp;
  pcBuf = "";
  pcBusy = false;
  pcAct = null;
  pcSay("Choose an action, then enter your PIN");
  pcRefresh();
  render(); // làm sáng box tên đang chọn
  $("pinDlg").showModal();
}
// Đóng khung PIN và mở hộp thoại kết quả
function openResultFor(emp) {
  $("pinDlg").close();
  lastAction = () => {
    closeScan();
    openPanel(emp);
  };
  if (!$("scanDlg").open) $("scanDlg").showModal();
}
function pcPress(k) {
  if (pcBusy || !pcAct) return; // chưa chọn chức năng thì không nhập PIN
  if (k === "c") pcBuf = "";
  else if (k === "b") pcBuf = pcBuf.slice(0, -1);
  else if (pcBuf.length < 4) pcBuf += k;
  pcSay(pcAct ? "Enter your PIN to " + PC_LABEL[pcAct] : "");
  pcRefresh();
  if (pcBuf.length === 4 && pcAct) pcRun(pcAct); // đã chọn chức năng + đủ 4 số: chạy luôn
}
function pcRun(act) {
  return act === "FACE" ? pcRegisterFace() : pcSubmit(act);
}
// Bấm nút chức năng: nếu đã nhập đủ PIN thì chạy ngay, chưa thì ghi nhớ chức năng rồi chờ nhập PIN
function pcChoose(act) {
  if (pcBusy) return;
  if (pcAct === act) {
    // Bấm lại nút đang chọn: bỏ chọn, hiện lại cả ba nút và xóa PIN đã nhập
    pcAct = null;
    pcBuf = "";
    pcSay("Choose an action, then enter your PIN");
    return pcRefresh();
  }
  if (pcBuf.length === 4) return pcRun(act);
  pcAct = act;
  pcSay("Enter your PIN to " + PC_LABEL[act]);
  pcRefresh();
}
async function pcSubmit(type) {
  if (pcBusy || !pcEmp || pcBuf.length !== 4) return;
  const emp = pcEmp,
    st = emp.status;
  const label = type === "IN" ? "Clock in" : "Clock out";

  // Trạng thái không hợp lệ thì báo lỗi ngay, không cần gửi PIN
  let pre = null;
  if (st && st.type === type) pre = { status: "SAME", time: st.time };
  else if (!st && type === "OUT") pre = { status: "NO_IN" };
  else if (st && st.type === "OUT" && type === "IN")
    pre = { status: "DONE_OUT", time: st.time };
  if (pre) {
    openResultFor(emp);
    return handleLog(emp, type, label, pre);
  }

  pcBusy = true;
  pcRefresh();
  pcSay("Checking...");
  try {
    const r = await api("logCheckPin", { id: emp.id, type, pin: pcBuf });
    if (r.status === "BAD_PIN") {
      pcBuf = "";
      return pcSay(`Incorrect PIN. ${r.left} attempt(s) left.`, true);
    }
    if (r.status === "LOCKED") {
      pcBuf = "";
      return pcSay(
        "Too many wrong attempts. Try again in 5 minutes.",
        true,
      );
    }
    openResultFor(emp);
    handleLog(emp, type, label, r); // r.status: OK hoặc UNKNOWN
  } catch (e) {
    openResultFor(emp);
    showResult({ ok: false, title: label + " Fail", sub: errText(e) });
  } finally {
    pcBusy = false;
    pcRefresh();
  }
}

// Đăng ký / đổi khuôn mặt cho người đang chọn (đã nhập đúng PIN). Đã có mặt thì ghi đè.
async function pcRegisterFace() {
  if (pcBusy || !pcEmp || pcBuf.length !== 4 || !ready) return;
  const emp = pcEmp,
    pin = pcBuf;
  pcBusy = true;
  pcRefresh();
  pcSay("Verifying PIN to register face...");
  let r;
  try {
    r = await api("checkRegister", { id: emp.id, pin }); // server kiểm tra PIN + đã có mặt chưa
  } catch (e) {
    pcBuf = "";
    pcBusy = false;
    pcRefresh();
    return pcSay(errText(e), true);
  }
  pcBusy = false;
  $("pinDlg").close();
  if (r && r.exists) {
    // Đã có khuôn mặt: hỏi xác nhận trước khi mở camera
    ovwPending = { id: emp.id, pin };
    $("ovwText").textContent =
      emp.name + " already registered a face. Overwrite it with a new one?";
    $("ovwDlg").showModal();
    return;
  }
  doRegister(emp.id, pin, false);
}
let ovwPending = null; // {id, pin} đang chờ xác nhận ghi đè
$("ovwNo").addEventListener("click", () => $("ovwDlg").close());
$("ovwYes").addEventListener("click", () => {
  if (!ovwPending) return;
  const { id, pin } = ovwPending;
  $("ovwDlg").close();
  doRegister(id, pin, true);
});
$("ovwDlg").addEventListener("close", () => {
  ovwPending = null; // đóng bằng nút Cancel hay phím Esc đều dọn sạch
});

[..."123456789", "c", "0", "b"].forEach((k) => {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "key" + (isNaN(k) ? " fn" : "");
  b.textContent = k === "c" ? "Clear" : k === "b" ? "⌫" : k;
  b.addEventListener("click", () => pcPress(k));
  $("pcKeys").appendChild(b);
});
$("pcIn").addEventListener("click", () => pcChoose("IN"));
$("pcOut").addEventListener("click", () => pcChoose("OUT"));
$("pcFace").addEventListener("click", () => pcChoose("FACE"));
$("pcClose").addEventListener("click", () => $("pinDlg").close());
// bấm ra ngoài hộp thoại (lên lớp nền) cũng đóng
$("pinDlg").addEventListener("click", (ev) => {
  if (ev.target === $("pinDlg") && !pcBusy) $("pinDlg").close();
});
$("pinDlg").addEventListener("close", () => {
  pcEmp = null; // tắt highlight
  pcBuf = "";
  pcBusy = false;
  pcAct = null;
  render();
});


/* ---------- Đăng ký nhiều góc mặt ---------- */
const FRONT_SAMPLES = 4; // số mẫu khi nhìn thẳng (góc dùng nhiều nhất nên lấy nhiều hơn)
const SIDE_SAMPLES = 2; // số mẫu mỗi bên trái / phải. Tổng vector = FRONT + 2 x SIDE, không vượt giới hạn của backend (hiện 15)
const POSE_TIMEOUT = 20000; // thời gian tối đa cho mỗi góc (ms)
const YAW_FRONT = 0.06; // lệch tối đa khi nhìn thẳng
const YAW_SIDE_MIN = 0.1; // lệch tối thiểu khi xoay trái/phải (nhỏ hơn: coi như chưa xoay đủ)
const YAW_SIDE_MAX = 0.3; // lệch tối đa (xoay quá nhiều thì mẫu không dùng được)
const FLIP_YAW = false; // nếu thấy hướng trái/phải bị ngược, đổi thành true

// Ước lượng độ xoay ngang từ 68 điểm mốc: so vị trí đầu mũi (điểm 30) với hai đầu đường hàm (điểm 0 và 16).
// Giá trị dương = mặt quay sang TRÁI màn hình (màn hình đang lật gương), âm = sang PHẢI, gần 0 = nhìn thẳng.
function yawOf(landmarks) {
  const p = landmarks.positions;
  const w = p[16].x - p[0].x;
  if (!w) return 0;
  const r = (p[30].x - p[0].x) / w; // khoảng 0.5 khi nhìn thẳng
  return (FLIP_YAW ? -1 : 1) * (r - 0.5);
}

const POSES = [
  {
    name: "Front",
    count: FRONT_SAMPLES,
    hint: "Look straight at the camera and hold still.",
    ok: (y) => Math.abs(y) <= YAW_FRONT,
  },
  {
    name: "Left",
    count: SIDE_SAMPLES,
    hint: "Turn your head slightly to the LEFT (toward the left of the screen).",
    ok: (y) => y >= YAW_SIDE_MIN && y <= YAW_SIDE_MAX,
  },
  {
    name: "Right",
    count: SIDE_SAMPLES,
    hint: "Turn your head slightly to the RIGHT (toward the right of the screen).",
    ok: (y) => y <= -YAW_SIDE_MIN && y >= -YAW_SIDE_MAX,
  },
];

// Trả về { samples } (mỗi mẫu là 1 vector 128 chiều), hoặc { cancelled }, hoặc { error: 'thông báo' }
async function capturePoses(token) {
  const samples = [];
  await sleep(700);
  for (let i = 0; i < POSES.length; i++) {
    const pose = POSES[i];
    const label = `Step ${i + 1}/${POSES.length}: ${pose.hint}`;
    let got = 0;
    const t0 = Date.now();
    $("camHint").textContent = label;
    while (got < pose.count && Date.now() - t0 < POSE_TIMEOUT) {
      if (token !== scanToken) return { cancelled: true };
      const r = await detectFull();
      if (r) {
        const y = yawOf(r.landmarks);
        console.log(`[register] ${pose.name}: yaw=${y.toFixed(3)}`); // xem số này để chỉnh YAW_* nếu cần
        if (pose.ok(y)) {
          samples.push(r.descriptor);
          got++;
          $("camHint").textContent = `${label} (${got}/${pose.count})`;
          await sleep(500);
          continue;
        }
      }
      await sleep(250);
    }
    if (got < pose.count) {
      return {
        error: `Could not capture the "${pose.name}" angle. Turn slightly in the right direction and try again.`,
      };
    }
    if (i < POSES.length - 1) {
      $("camHint").textContent = "Good. Get ready for the next step...";
      await sleep(900);
    }
  }
  return { samples };
}

async function doRegister(id, pin, overwrite) {
  const token = ++scanToken;
  lastAction = () => doRegister(id, pin, overwrite);
  openScan(
    overwrite ? "Update" : "Register",
    "Look straight at the camera and hold still.",
  );

  try {
    await startCamera();
    if (token !== scanToken) return stopCamera();
  } catch (e) {
    return showResult({
      ok: false,
      title: "Registration Fail",
      sub: cameraReason(),
    });
  }

  try {
    const cap = await capturePoses(token);
    if (cap.cancelled || token !== scanToken) return;
    if (cap.error)
      return showResult({
        ok: false,
        title: "Registration Fail",
        sub: cap.error,
      });

    // Lưu TỪNG vector riêng (làm tròn 4 chữ số cho gọn ô Sheet), không lấy trung bình
    const vecs = cap.samples.map((s) =>
      Array.from(s, (v) => +v.toFixed(4)),
    );
    // Chặn một khuôn mặt đăng ký cho hai mã: so với mẫu của mọi mã khác (server kiểm tra lại)
    const clash = employees.find(
      (e) =>
        e.id !== id &&
        e.descs &&
        e.descs.some((d) =>
          vecs.some((v) => faceapi.euclideanDistance(v, d) <= THRESHOLD),
        ),
    );
    if (clash)
      return showResult({
        ok: false,
        title: "Registration Fail",
        sub: "This face is already registered under another staff code.",
      });
    const empName = await api("registerEmployee", {
      id,
      descJson: JSON.stringify(vecs),
      pin,
      overwrite,
    });
    const descs = vecs.map((v) => new Float32Array(v));
    const ex = employees.find((e) => e.id === id);
    if (ex) {
      ex.descs = descs; // ghi đè khuôn mặt của người đã có
      ex.name = empName;
    } else {
      employees.push({ id, name: empName, descs, status: null });
    }
    render(id);

    showResult({
      ok: true,
      kind: "in",
      title: overwrite ? "Updated" : "Registered",
      sub: empName,
    });
  } catch (e) {
    showResult({
      ok: false,
      title: "Registration Fail",
      sub: errText(e),
    });
  }
}

/* ---------- Hàng đợi ghi nhận ở nền (optimistic UI) ---------- */
const QUEUE_KEY = "chamcong_queue";
const MAX_AGE_MS = 12 * 3600 * 1000; // bỏ bản ghi chờ quá 12 giờ
let syncQueue = loadQueue();
let syncRunning = false;
let noticeTimer = null,
  warnUntil = 0;

function loadQueue() {
  try {
    const a = JSON.parse(localStorage.getItem(QUEUE_KEY) || "[]");
    return a.filter(
      (x) =>
        x &&
        x.id &&
        (x.type === "IN" || x.type === "OUT") &&
        Date.now() - x.ts < MAX_AGE_MS,
    );
  } catch (e) {
    return [];
  }
}
function saveQueue() {
  // lưu vào máy để không mất khi tải lại trang
  try {
    localStorage.setItem(
      QUEUE_KEY,
      JSON.stringify(
        syncQueue.map(({ id, name, type, ts, tries }) => ({
          id,
          name,
          type,
          ts,
          tries,
        })),
      ),
    );
  } catch (e) {}
}

const localTime = (ms) =>
  new Date(ms).toLocaleTimeString("en-GB", {
    timeZone: TZ,
    hourCycle: "h23",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
const secsOf = (s) => {
  const p = String(s || "")
    .split(":")
    .map(Number);
  return (p[0] || 0) * 3600 + (p[1] || 0) * 60 + (p[2] || 0);
};

// Dòng thông báo nhỏ phía trên nút Check in/out
function notice(text, opt) {
  opt = opt || {};
  const el = $("actNote");
  clearTimeout(noticeTimer);
  el.hidden = !text;
  el.textContent = text || "";
  el.style.color = opt.warn ? "var(--fail)" : "";
  if (opt.warn) warnUntil = opt.sticky ? Infinity : Date.now() + 10000;
  if (text && !opt.sticky)
    noticeTimer = setTimeout(updateSyncNotice, 10000);
}
function updateSyncNotice() {
  if (Date.now() < warnUntil) return; // đang hiện cảnh báo thì không ghi đè
  const slow =
    syncQueue.length > 1 || (syncQueue[0] && syncQueue[0].tries > 0);
  notice(slow ? `Syncing ${syncQueue.length} record(s)...` : "", {
    sticky: true,
  });
}

// Đặt lại trạng thái tạm (lần chấm công đã hiện thành công nhưng chưa được máy chủ xác nhận)
function applyPending() {
  syncQueue.forEach((it) => {
    const e = employees.find((x) => x.id === it.id);
    if (e) e.status = { type: it.type, time: localTime(it.ts) };
  });
}
async function refreshStatuses() {
  try {
    applyStatuses(await api("getStatuses"));
  } catch (e) {}
}

function enqueueCheck(emp, type) {
  syncQueue.push({
    id: emp.id,
    name: emp.name,
    type,
    ts: Date.now(),
    tries: 0,
  });
  saveQueue();
  processQueue();
}

async function processQueue() {
  if (syncRunning) return;
  syncRunning = true;
  try {
    while (syncQueue.length) {
      const item = syncQueue[0];
      updateSyncNotice();
      let call;
      try {
        call = await apiTimed("logCheck", {
          id: item.id,
          type: item.type,
          ts: item.ts,
        });
      } catch (e) {
        if (e.code === "UNAUTHORIZED") {
          notice(
            "Device ID is no longer valid. Reload the page to enter it again. Pending records are kept.",
            { warn: true, sticky: true },
          );
          return;
        }
        item.tries = (item.tries || 0) + 1;
        const limit = e.code === "SERVER" ? 3 : 20; // lỗi mạng thử nhiều lần hơn lỗi do máy chủ trả về
        if (item.tries >= limit) {
          syncQueue.shift();
          saveQueue();
          notice(
            `${item.name}: ${item.type === "IN" ? "check in" : "check out"} could not be recorded (${errText(e)}). Please try again.`,
            { warn: true },
          );
          await refreshStatuses(); // trả trạng thái về đúng như máy chủ
          continue;
        }
        saveQueue();
        await sleep(Math.min(30000, 2000 * Math.pow(2, item.tries - 1)));
        continue;
      }
      syncQueue.shift();
      saveQueue();
      applyServerResult(item, call);
    }
  } finally {
    syncRunning = false;
    updateSyncNotice();
  }
}

// Máy chủ trả kết quả thật cho một lần chấm công đã hiện thành công trước đó
function applyServerResult(item, call) {
  const r = call.data || {};
  const verb = item.type === "IN" ? "check in" : "check out";
  const e = employees.find((x) => x.id === item.id);

  if (r.status === "OK") {
    if (e) e.status = { type: item.type, time: r.time }; // giờ chính thức do máy chủ ghi
    render();
  } else if (r.status === "SAME") {
    // Đã có bản ghi cùng loại. Nếu giờ trùng khoảng giờ quét thì coi như lần gửi trước đã thành công (chỉ mất phản hồi).
    if (e && r.time) e.status = { type: item.type, time: r.time };
    render();
    if (Math.abs(secsOf(r.time) - secsOf(localTime(item.ts))) > 90) {
      notice(
        `${item.name}: already ${item.type === "IN" ? "checked in" : "checked out"} at ${r.time}. This scan was not added.`,
        { warn: true },
      );
    }
  } else {
    const why =
      r.status === "NO_IN"
        ? "has not checked in today"
        : r.status === "UNKNOWN"
          ? "was not found in the list"
          : "was rejected by the server (only one check in and one check out per day)";
    notice(`${item.name}: ${verb} was NOT recorded (${why}).`, {
      warn: true,
    });
    refreshStatuses();
  }
}
window.addEventListener("online", processQueue);

/* ---------- Khởi động ---------- */
async function loadFaceModels() {
  if (typeof faceapi === "undefined") {
    throw new Error("face-api.js did not load");
  }
  await faceapi.tf.ready();
  const backend = faceapi.tf.getBackend();
  console.log("TF backend:", backend); // nên là "webgl"

  if (backend === "webgl" && !FORCE_TINY) {
    await faceapi.nets.ssdMobilenetv1.loadFromUri(MODEL_URL);
    DET_OPTS = new faceapi.SsdMobilenetv1Options({ minConfidence: 0.3 });
    DET_NAME = "ssd";
  } else {
    // Không có WebGL: dùng bộ phát hiện nhẹ để quét kịp trong 10 giây
    await faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL);
    DET_OPTS = new faceapi.TinyFaceDetectorOptions({
      inputSize: 416,
      scoreThreshold: 0.7,
    });
    DET_NAME = "tiny";
  }
  await faceapi.nets.faceLandmark68Net.loadFromUri(MODEL_URL);
  await faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_URL);
}

async function init() {
  if (!API_URL || API_URL.indexOf("DAN_URL") === 0) {
    throw new Error("API_URL is not set in index.html.");
  }

  let msg = "";
  for (;;) {
    if (!getToken()) await askToken(msg);
    try {
      await loadData();
      break;
    } catch (e) {
      if (e.code === "UNAUTHORIZED") {
        msg = "Incorrect Device ID.";
        continue;
      }
      throw e;
    }
  }
  render();

  // Danh sách (từ M_Employee) và chấm công bằng PIN dùng được ngay, không cần chờ model khuôn mặt.
  // Mỗi 60 giây (và khi màn hình hiện lại) cập nhật tên / trạng thái / khuôn mặt mới từ server.
  setInterval(refreshRoster, 60000);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") refreshRoster();
  });
  $("actNote").textContent =
    "Loading face recognition... PIN check-in is available now.";

  try {
    await loadFaceModels();
    ready = true;
    $("btnIn").disabled = false;
    $("btnOut").disabled = false;
    $("actNote").hidden = true;
    if ($("pinDlg").open) pcRefresh(); // mở sẵn hộp PIN: bật icon khuôn mặt
  } catch (e) {
    $("actNote").textContent =
      "Face recognition is unavailable (" +
      errText(e) +
      "). PIN check-in still works.";
  } finally {
    processQueue(); // gửi các bản ghi còn tồn từ lần trước (nếu có)
  }
}
init().catch((e) => {
  $("listNote").hidden = false;
  $("listNote").textContent = "Failed to load data: " + errText(e);
  $("actNote").textContent = "Reload the page to try again.";
});
