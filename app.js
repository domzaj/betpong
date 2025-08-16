// Init Firebase
firebase.initializeApp(firebaseConfig);
const auth = firebase.auth();
const db = firebase.firestore();

const $ = (id)=>document.getElementById(id);
const state = { uid:null, isHost:false, nick:null, balance:0 };
const msg = (t)=> $('authMsg').textContent = t || '';

// Toast
const toast = (t, ms=1800)=>{
  const el=$('toast');
  el.textContent=t;
  el.classList.remove('hidden');
  setTimeout(()=>el.classList.add('hidden'), ms);
};

// Modal obstawiania
const betModal = {
  open(mid, m, outcome, price, balance){
    $('betModal').classList.remove('hidden');
    $('betInfo').textContent = `${m.p1} vs ${m.p2} | wybór: ${outcome.toUpperCase()} @ ${price} | saldo: ${balance}`;
    $('stakeInput').value = 10;
    this._ctx = { mid, m, outcome, price };
  },
  close(){ $('betModal').classList.add('hidden'); this._ctx=null; }
};
$('betCancel').onclick = ()=> betModal.close();
$('betConfirm').onclick = async ()=>{
  const ctx = betModal._ctx; if(!ctx) return;
  const stake = parseInt($('stakeInput').value,10);
  if (!Number.isFinite(stake) || stake<=0 || stake>state.balance) { toast('Błędna stawka'); return; }
  try{
    const batch = db.batch();
    const bRef = db.collection('bets').doc();
    batch.set(bRef, {
      uid: state.uid, mid: ctx.mid, outcome: ctx.outcome, stake, priceAt: ctx.price,
      status:'open', payout:0, createdAt: firebase.firestore.FieldValue.serverTimestamp()
    });
    batch.update(db.doc(`players/${state.uid}`), { balance: firebase.firestore.FieldValue.increment(-stake) });
    await batch.commit();
    betModal.close();
    toast('Zakład przyjęty');
  }catch(e){ toast('Błąd przy dodawaniu'); console.error(e); }
};

// Auth
$('signup').onclick = async () => {
  const e = email.value.trim(), p = pass.value;
  if (!e || p.length < 6) return msg('Hasło min. 6 znaków');
  try {
    await auth.createUserWithEmailAndPassword(e,p);
    await auth.currentUser.sendEmailVerification();
    msg('Utworzono. Sprawdź email i zweryfikuj.');
  } catch(err){ msg(err.message); }
};
$('login').onclick = async () => {
  try { await auth.signInWithEmailAndPassword(email.value.trim(), pass.value); msg('Zalogowano'); }
  catch(err){ msg(err.message); }
};
$('logout').onclick = async () => { await auth.signOut(); };
$('reset').onclick = async () => {
  try { await auth.sendPasswordResetEmail(email.value.trim()); msg('Wysłano link resetu'); }
  catch(err){ msg(err.message); }
};
$('saveNick').onclick = async ()=>{
  if (!state.uid) return;
  const n = $('nick').value.trim().slice(0,20);
  if (!n) return;
  await db.doc(`players/${state.uid}`).set({ nick:n }, { merge:true });
};

auth.onAuthStateChanged(async (user)=>{
  $('uid').textContent = user ? `uid: ${user.uid.slice(0,6)}…` : '';
  $('emailBadge').textContent = user?.email ? user.email : '';
  $('verifyWarn').classList.toggle('hidden', !!user?.emailVerified);

  if (!user) return;
  state.uid = user.uid;

  // isHost?
  const adminDoc = await db.doc(`admins/${state.uid}`).get();
  state.isHost = adminDoc.exists;
  document.querySelector('.adminOnly').classList.toggle('hidden', !state.isHost);

  // ensure player profile
  const pRef = db.doc(`players/${state.uid}`);
  const pSnap = await pRef.get();
  if (!pSnap.exists) await pRef.set({ nick:`player-${state.uid.slice(0,4)}`, balance:1000 });

  // live own profile
  pRef.onSnapshot(s=>{
    const d = s.data()||{};
    state.nick = d.nick; state.balance = d.balance||0;
    $('nick').value = d.nick || '';
    $('balance').textContent = `saldo: ${state.balance}`;
  });

  // streams
  db.collection('matches').orderBy('startAt').onSnapshot(renderMatches);
  db.collection('bets').where('uid','==',state.uid).orderBy('createdAt','desc').onSnapshot(renderMyBets);
  db.collection('players').onSnapshot(renderLeaderboard);
});

// Admin actions
$('addMatch').onclick = async ()=>{
  if (!state.isHost) return;
  const p1 = $('p1').value.trim(), p2 = $('p2').value.trim();
  const startAtVal = $('startAt').value;
  if (!p1 || !p2 || !startAtVal) return;
  const startAt = new Date(startAtVal).toISOString();
  const mRef = db.collection('matches').doc();
  await mRef.set({ tid:'default', p1, p2, startAt, status:'open', score:null, winner:null });
  await db.collection('odds').doc(mRef.id).set({ mid:mRef.id, market:'WINNER', outcomes:{p1:1.85,p2:1.95}, locked:false });
};
$('lockAll').onclick = async ()=>{
  if (!state.isHost) return;
  const qs = await db.collection('matches').where('status','==','open').get();
  const batch = db.batch();
  qs.forEach(doc=>{
    batch.update(doc.ref,{ status:'locked' });
    batch.update(db.collection('odds').doc(doc.id), { locked:true });
  });
  await batch.commit();
};

// Render
async function renderMatches(qs){
  const wrap = $('matches'); wrap.innerHTML = '';
  for (const doc of qs.docs){
    const m = doc.data(); const mid = doc.id;
    const oSnap = await db.collection('odds').doc(mid).get();
    const o = oSnap.exists ? oSnap.data() : null;
    const div = document.createElement('div'); div.className='match';
    const when = m.startAt ? new Date(m.startAt).toLocaleString() : '-';

    const statusBadge =
      m.status==='open'     ? '<span class="badge green">otwarty</span>' :
      m.status==='locked'   ? '<span class="badge gray">zablokowany</span>' :
      '<span class="badge red">zakończony</span>';

    div.innerHTML = `
      <div class="head">
        <div><strong>${m.p1}</strong> vs <strong>${m.p2}</strong> • <span class="muted">${when}</span></div>
        ${statusBadge}
      </div>
      <div class="row">
        <button data-o="p1">🟢 ${m.p1} @ ${o?o.outcomes.p1:'-'}</button>
        <button data-o="p2">🔵 ${m.p2} @ ${o?o.outcomes.p2:'-'}</button>
        ${state.isHost ? `
          <input class="score" placeholder="np. 3:1" />
          <select class="winner">
            <option value="">winner</option>
            <option value="p1">${m.p1}</option>
            <option value="p2">${m.p2}</option>
          </select>
          <button class="close">Zamknij</button>
          <button class="settle">Rozlicz</button>
        `:''}
      </div>
    `;

    // obstawianie
    for (const btn of div.querySelectorAll('button[data-o]')) {
      const disabled = m.status!=='open' || !o || !auth.currentUser?.emailVerified;
      btn.disabled = !!disabled;
      btn.onclick = ()=>{
        if (disabled) return;
        const outcome = btn.getAttribute('data-o');
        const priceAt = o.outcomes[outcome];
        betModal.open(mid, m, outcome, priceAt, state.balance);
      };
    }

    // host tools
    if (state.isHost){
      div.querySelector('.close').onclick = async ()=>{
        await db.collection('matches').doc(mid).update({ status:'locked' });
        await db.collection('odds').doc(mid).update({ locked:true });
      };
      div.querySelector('.settle').onclick = async ()=>{
        const score = div.querySelector('.score').value.trim();
        const winner = div.querySelector('.winner').value;
        if (!score || !winner) return;
        await db.collection('matches').doc(mid).update({ status:'finished', score, winner });
        const bets = await db.collection('bets').where('mid','==',mid).get();
        const batch = db.batch();
        bets.forEach(b=>{
          const d = b.data();
          const win = d.outcome === winner;
          const payout = win ? Math.round(d.stake * d.priceAt) : 0;
          batch.update(b.ref, { status: win?'won':'lost', payout });
          if (payout>0){
            batch.update(db.doc(`players/${d.uid}`), { balance: firebase.firestore.FieldValue.increment(payout) });
          }
        });
        await batch.commit();
        toast('Rozliczono mecz');
      };
    }

    wrap.appendChild(div);
  }
}

function renderMyBets(qs){
  const wrap = $('myBets'); wrap.innerHTML = '';
  qs.forEach(doc=>{
    const b = doc.data();
    const d = document.createElement('div'); d.className='match';
    d.innerHTML = `<strong>${b.mid}</strong> | ${b.outcome} @ ${b.priceAt} | stawka: ${b.stake} | <span class="badge ${b.status==='won'?'green':b.status==='open'?'gray':'red'}">${b.status}</span> | wypłata: ${b.payout}`;
    wrap.appendChild(d);
  });
}

function renderLeaderboard(qs){
  const data = qs.docs.map(d=>({ uid:d.id, ...d.data() }))
    .sort((a,b)=> (b.balance??0)-(a.balance??0));
  const wrap = $('leaderboard'); wrap.innerHTML='';
  data.forEach((p,i)=>{
    const row = document.createElement('div'); row.className='row';
    row.innerHTML = `<span class="badge">#${i+1}</span> <strong>${p.nick||'anon'}</strong> — ${p.balance??0}`;
    wrap.appendChild(row);
  });
}

// Tabs
document.querySelectorAll('.tab').forEach(btn=>{
  btn.onclick = ()=>{
    document.querySelectorAll('.tab').forEach(b=>b.classList.remove('active'));
    document.querySelectorAll('.tabpanel').forEach(s=>s.classList.add('hidden'));
    btn.classList.add('active');
    document.getElementById(btn.dataset.tab).classList.remove('hidden');
  };
});
// Bottom nav → przełączanie ekranów
function showTab(id){
  document.querySelectorAll('.tabpanel').forEach(s=>s.classList.add('hidden'));
  document.getElementById(id).classList.remove('hidden');
  document.querySelectorAll('.bn-item').forEach(b=>b.classList.remove('active'));
  document.querySelector(`.bn-item[data-tab="${id}"]`)?.classList.add('active');
  // scroll do góry nowego ekranu
  window.scrollTo({ top: 0, behavior: 'instant' });
}
document.querySelectorAll('.bn-item').forEach(btn=>{
  btn.onclick = ()=> showTab(btn.dataset.tab);
});

// Admin – osobny ekran wywoływany guzikiem w nagłówku
$('adminBtn').onclick = ()=> showTab('adminTab');
