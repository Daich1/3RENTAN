// ===== SANRENTAN Audio =====
// 効果音とBGMは WebAudio でその場で合成する。音源ファイルを持たないので
// 追加のダウンロードもライセンス管理も要らず、初回タップの瞬間から鳴る。

const SOUND_KEY = 'srt_sound';
const AC = window.AudioContext || window.webkitAudioContext;

let actx = null, master = null, sfxBus = null, bgmBus = null, noiseBuf = null;
let soundOn = true;
try { soundOn = localStorage.getItem(SOUND_KEY) !== 'off'; } catch (e) {}

function initAudio() {
  if (actx || !AC) return actx;
  actx = new AC();
  master = actx.createGain(); master.gain.value = soundOn ? 0.9 : 0.0001;
  master.connect(actx.destination);
  sfxBus = actx.createGain(); sfxBus.gain.value = 1; sfxBus.connect(master);
  bgmBus = actx.createGain(); bgmBus.gain.value = 0.0001; bgmBus.connect(master);
  // ホワイトノイズは1秒ぶんを使い回す（めくり音・ハイハットの素）
  noiseBuf = actx.createBuffer(1, actx.sampleRate, actx.sampleRate);
  const d = noiseBuf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  return actx;
}

// iOS/Chrome は最初のユーザー操作までコンテキストを止める。
// 復帰後にまた止まることがあるので、操作のたびに起こしにいく
function unlock() {
  if (!soundOn) return;
  const c = initAudio();
  if (c && c.state === 'suspended') c.resume();
}
['pointerdown', 'keydown'].forEach(ev =>
  document.addEventListener(ev, unlock, { passive: true }));
// 裏に回っている間は止める（電池と、復帰時の音の詰まりの対策）
document.addEventListener('visibilitychange', () => {
  if (!actx) return;
  if (document.hidden) actx.suspend();
  else if (soundOn) actx.resume();
});

const ready = () => soundOn && !!initAudio() && actx.state !== 'closed';
// 予約時刻の基準。最初の音が now() から始まる種類でも落ちないよう自前で初期化する
const now = () => (initAudio() ? actx.currentTime : 0);
const NOTE = semi => 440 * Math.pow(2, semi / 12);   // A4 を 0 とした半音

// ===== 発音プリミティブ =====
// t は絶対時刻（actx.currentTime 基準）。省略時は即時
function tone(o) {
  if (!ready()) return;
  const t = o.t || now();
  const dur = o.dur || 0.2;
  const osc = actx.createOscillator();
  const g = actx.createGain();
  osc.type = o.type || 'triangle';
  osc.frequency.setValueAtTime(o.freq, t);
  if (o.to) osc.frequency.exponentialRampToValueAtTime(o.to, t + dur);
  // ゲインは exponential でしか自然に減衰しないので 0 は使わない
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(o.vol == null ? 0.25 : o.vol, t + (o.attack || 0.01));
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  osc.connect(g).connect(o.bus || sfxBus);
  osc.start(t); osc.stop(t + dur + 0.02);
}
function noise(o) {
  if (!ready()) return;
  const t = o.t || now();
  const dur = o.dur || 0.18;
  const src = actx.createBufferSource();
  src.buffer = noiseBuf; src.loop = true;
  const f = actx.createBiquadFilter();
  f.type = 'bandpass'; f.Q.value = o.q || 1.2;
  f.frequency.setValueAtTime(o.freq, t);
  if (o.to) f.frequency.exponentialRampToValueAtTime(o.to, t + dur);
  const g = actx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(o.vol == null ? 0.2 : o.vol, t + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  src.connect(f).connect(g).connect(o.bus || sfxBus);
  src.start(t, Math.random() * 0.5); src.stop(t + dur + 0.02);
}
// ファンファーレの裏で BGM を一時的に下げる
function duck(secs) {
  if (!bgmBus || !curMood || !ready()) return;
  const t = now(), v = MOODS[curMood].vol;
  bgmBus.gain.cancelScheduledValues(t);
  bgmBus.gain.setValueAtTime(v * 0.3, t);
  bgmBus.gain.linearRampToValueAtTime(v, t + secs);
}

// ===== 効果音 =====
const SFX = {
  tap:   () => tone({ freq: 520, to: 380, dur: 0.07, type: 'square', vol: 0.10 }),
  back:  () => tone({ freq: 360, to: 240, dur: 0.10, type: 'square', vol: 0.09 }),
  // 1位→2位→3位と選ぶほど音が上がる
  pick:  i => {
    const s = [0, 4, 7][i] || 0;
    tone({ freq: NOTE(3 + s), dur: 0.16, vol: 0.20 });
    noise({ freq: 2600, to: 1400, dur: 0.05, vol: 0.06 });
  },
  undo:  () => tone({ freq: 420, to: 210, dur: 0.14, type: 'sawtooth', vol: 0.12 }),
  submit: () => [0, 4, 7, 12].forEach((s, i) =>
    tone({ freq: NOTE(3 + s), t: now() + i * 0.05, dur: 0.3, vol: 0.16 })),
  // 山札シャッフル
  deck:  () => {
    for (let i = 0; i < 7; i++) {
      noise({ t: now() + i * 0.09, freq: 1200, to: 3000, dur: 0.07, vol: 0.10 });
    }
  },
  // お題が出た瞬間
  odai:  () => {
    [0, 7, 12].forEach((s, i) =>
      tone({ freq: NOTE(3 + s), t: now() + i * 0.06, dur: 0.35, vol: 0.18, type: 'sine' }));
    noise({ freq: 3000, to: 900, dur: 0.25, vol: 0.07 });
  },
  // 順位カードのめくり。CSS の .55s に合わせて着地で音を置く
  flip:  rank => {
    const s = [0, 3, 7][rank] || 0;
    noise({ freq: 500, to: 3000, dur: 0.18, vol: 0.13, q: 0.8 });
    tone({ freq: NOTE(-12 + s), t: now() + 0.1, dur: 0.32, vol: 0.20 });
  },
  // その枠に的中者がいた
  hit:   () => {
    tone({ freq: NOTE(19), dur: 0.35, vol: 0.18, type: 'sine' });
    tone({ freq: NOTE(26), t: now() + 0.06, dur: 0.3, vol: 0.10, type: 'sine' });
  },
  // 配当オープン
  payout: () => {
    duck(1.6);
    const t = now();
    [0, 4, 7, 12].forEach((s, i) =>
      tone({ freq: NOTE(3 + s), t: t + i * 0.09, dur: 0.5, vol: 0.20 }));
    [0, 4, 7, 12].forEach(s =>
      tone({ freq: NOTE(3 + s), t: t + 0.42, dur: 0.9, vol: 0.11, type: 'sine' }));
    noise({ t: t + 0.4, freq: 4000, to: 1500, dur: 0.5, vol: 0.06 });
  },
  // 自分がサンレンタン／サンレンプクを当てた
  bigwin: () => {
    duck(2.2);
    const t = now();
    [0, 4, 7, 12, 16, 19, 24].forEach((s, i) =>
      tone({ freq: NOTE(3 + s), t: t + i * 0.07, dur: 0.45, vol: 0.20 }));
    [0, 7, 12, 16].forEach(s =>
      tone({ freq: NOTE(3 + s), t: t + 0.55, dur: 1.3, vol: 0.12, type: 'sine' }));
    for (let i = 0; i < 5; i++) {
      noise({ t: t + 0.6 + i * 0.08, freq: 5000, to: 2500, dur: 0.12, vol: 0.05 });
    }
  },
  // 残り10秒の刻み
  tick:  () => tone({ freq: NOTE(15), dur: 0.06, type: 'square', vol: 0.09 }),
  join:  () => [0, 7].forEach((s, i) =>
    tone({ freq: NOTE(3 + s), t: now() + i * 0.07, dur: 0.22, vol: 0.15 })),
  start: () => {
    const t = now();
    [0, 4, 7, 12, 19].forEach((s, i) =>
      tone({ freq: NOTE(-2 + s), t: t + i * 0.08, dur: 0.4, vol: 0.20 }));
    noise({ t: t + 0.3, freq: 800, to: 4000, dur: 0.4, vol: 0.08 });
  },
  final: () => {
    const t = now();
    [0, 4, 7, 12, 11, 12].forEach((s, i) =>
      tone({ freq: NOTE(3 + s), t: t + i * 0.12, dur: 0.55, vol: 0.20 }));
    [0, 4, 7, 12].forEach(s =>
      tone({ freq: NOTE(3 + s), t: t + 0.78, dur: 1.6, vol: 0.13, type: 'sine' }));
  },
};

// ===== BGM =====
// 8分音符ごとに音を置く簡易シーケンサ。setInterval の揺れは
// 少し先まで予約する（lookahead）ことで吸収する。
const CHORD = { maj: [0,4,7], min: [0,3,7], maj7: [0,4,7,11], min7: [0,3,7,10], dom7: [0,4,7,10] };
const MOODS = {
  // ロビー: 長居しても疲れないラウンジ寄り
  lobby:  { bpm: 92,  vol: 0.13, bass: 4, hat: 2, arp: 'up',
            prog: [[-9,'maj7'], [-12,'min7'], [-4,'maj7'], [-2,'dom7']] },
  // お題・回答: 刻みを速くして少し急かす
  answer: { bpm: 116, vol: 0.12, bass: 2, hat: 1, arp: 'up',
            prog: [[-12,'min'], [-4,'maj'], [-9,'maj'], [-2,'maj']] },
  // 発表: 音数を落として引っ張る
  reveal: { bpm: 78,  vol: 0.14, bass: 4, hat: 0, arp: 'pulse',
            prog: [[-12,'min'], [-5,'min']] },
};

let wantMood = null;   // 鳴らしたいBGM（ミュート中も覚えておく）
let curMood  = null;   // 実際に鳴っているBGM
let bgmStep = 0, bgmTime = 0, bgmTimer = null;

function bgmBeat(m, i, t) {
  const [root, type] = m.prog[Math.floor(i / 8) % m.prog.length];
  const iv = CHORD[type];
  const s = i % 8;
  if (m.bass && s % m.bass === 0) {
    tone({ freq: NOTE(root - 24), t, dur: 0.5, type: 'sine', vol: 0.5, bus: bgmBus });
  }
  if (m.hat && s % m.hat === 0) {
    noise({ freq: 7000, dur: 0.04, vol: 0.05, q: 2, t, bus: bgmBus });
  }
  if (m.arp === 'up') {
    const n = iv[s % iv.length] + (s >= iv.length ? 12 : 0);
    tone({ freq: NOTE(root + n), t, dur: 0.22, type: 'triangle', vol: 0.22, bus: bgmBus });
  } else if (m.arp === 'pulse' && (s === 0 || s === 4)) {
    iv.forEach(n => tone({ freq: NOTE(root + n), t, dur: 1.1, type: 'sine', vol: 0.16, bus: bgmBus }));
  }
}

function bgmTick() {
  if (!curMood || !ready()) return;
  const m = MOODS[curMood];
  const stepDur = 30 / m.bpm;               // 8分音符の長さ
  if (bgmTime < now()) bgmTime = now() + 0.02;  // 復帰直後に過去ぶんを詰め込まない
  while (bgmTime < now() + 0.2) {
    bgmBeat(m, bgmStep, bgmTime);
    bgmTime += stepDur;
    bgmStep++;
  }
}

function syncBgm() {
  if (!soundOn || !wantMood) return stopBgm();
  if (curMood === wantMood) return;
  if (!initAudio()) return;
  curMood = wantMood;
  bgmStep = 0; bgmTime = now() + 0.05;
  const t = now();
  bgmBus.gain.cancelScheduledValues(t);
  bgmBus.gain.setValueAtTime(0.0001, t);
  bgmBus.gain.linearRampToValueAtTime(MOODS[curMood].vol, t + 0.8);
  if (!bgmTimer) bgmTimer = setInterval(bgmTick, 40);
}
function stopBgm() {
  if (!curMood && !bgmTimer) return;   // 毎ポーリング呼ばれるので二度手間を避ける
  if (bgmTimer) { clearInterval(bgmTimer); bgmTimer = null; }
  curMood = null;
  if (!bgmBus) return;
  const t = now();
  bgmBus.gain.cancelScheduledValues(t);
  bgmBus.gain.setValueAtTime(bgmBus.gain.value, t);
  bgmBus.gain.linearRampToValueAtTime(0.0001, t + 0.4);
}

// ===== Public API =====
const Sound = {
  play(name, arg) { if (SFX[name]) SFX[name](arg); },
  // mood: 'lobby' | 'answer' | 'reveal' | null（null で停止）
  bgm(mood) { wantMood = mood || null; syncBgm(); },
  isOn: () => soundOn,
  toggle() {
    soundOn = !soundOn;
    try { localStorage.setItem(SOUND_KEY, soundOn ? 'on' : 'off'); } catch (e) {}
    if (soundOn) {
      unlock();
      if (master) master.gain.setTargetAtTime(0.9, now(), 0.05);
      syncBgm();
      SFX.tap();
    } else {
      // 先に予約済みのファンファーレも黙らせたいのでマスターごと落とす
      if (master) master.gain.setTargetAtTime(0.0001, now(), 0.05);
      stopBgm();
    }
    return soundOn;
  },
};
