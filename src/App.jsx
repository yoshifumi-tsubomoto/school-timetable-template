import React, { useState, useMemo, useRef, useEffect } from "react";
// ── 学校ごとの設定（接続先・学校名）は src/config.js に分離 ─────────────────
// 【v8_7_33】他校展開のため、接続先URL・キーの直書きをやめて config.js から読む。
// 【v8_7_34】学校名も config.js から読むように変更（初期値。データベースに登録済みの
//   学校名があればそちらが優先される。初期設定より前の段階でもヘッダーに正しい名前が出る）。
//   config.js は必ず src/ フォルダに置き、実際の値が入っていること（空欄のままだと動かない）。
import { SUPABASE_URL, SUPABASE_KEY, SCHOOL_NAME } from "./config.js";

// ── 体験モード判定 ────────────────────────────────────────────────────────────
// URL に ?demo=1 が付いていればデモ（体験版）。ログイン不要・保存はメモリのみ・
// 本番Supabaseへの書き込みは一切行わない。
const IS_DEMO=(()=>{
  try{return new URLSearchParams(window.location.search).get("demo")==="1";}catch(_){return false;}
})();

// ── アプリのバージョン ───────────────────────────────────────────────────────
// ヘッダーの学校名のとなりに表示される。新しい版を出すたびにこの値を更新する。
const APP_VERSION="8_7_34";

// ── Supabase Auth クライアント（CDN動的ロード） ───────────────────────────────
// パッケージ依存を増やさず、Google Identity Services と同じく CDN から読み込む。
// window.supabase.createClient でクライアントを生成し、ログイン/セッションに使う。
let _sbClient=null;
let _sbClientPromise=null;
const getSupabaseClient=()=>{
  if(_sbClient)return Promise.resolve(_sbClient);
  if(_sbClientPromise)return _sbClientPromise;
  _sbClientPromise=new Promise((resolve,reject)=>{
    const make=()=>{
      try{
        _sbClient=window.supabase.createClient(SUPABASE_URL,SUPABASE_KEY,{
          auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:true},
        });
        resolve(_sbClient);
      }catch(e){reject(e);}
    };
    if(window.supabase&&window.supabase.createClient){make();return;}
    if(document.getElementById("supabase-js-script")){
      // 既に読み込み中: ロード完了を待つ
      const iv=setInterval(()=>{
        if(window.supabase&&window.supabase.createClient){clearInterval(iv);make();}
      },50);
      setTimeout(()=>clearInterval(iv),10000);
      return;
    }
    const s=document.createElement("script");
    s.id="supabase-js-script";
    s.src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js";
    s.async=true;
    s.onload=make;
    s.onerror=()=>reject(new Error("supabase-js の読み込みに失敗しました"));
    document.head.appendChild(s);
  });
  return _sbClientPromise;
};
// 現在のセッションのアクセストークンを返す（未ログインなら null）
const getAccessToken=async()=>{
  try{
    const sb=await getSupabaseClient();
    const{data}=await sb.auth.getSession();
    return data?.session?.access_token||null;
  }catch(_){return null;}
};
const sbFetch=async(path,opt={})=>{
  // 体験モードでは本番DBへの書き込み・読み込みを行わず、ダミーレスポンスを返す
  // （誤って公開データ id='main' を上書きする事故を防ぐ）
  if(IS_DEMO){
    return {
      ok:true,status:200,
      json:async()=>[],            // 読み込み系は空配列（→デモ用初期データが使われる）
      text:async()=>'',
      clone(){return this;},
    };
  }
  // ログイン中ならそのアクセストークンを使う（→ authenticated ロールでRLS判定）。
  // 未ログイン（生徒・教員のトークンビュー等）は anon キーにフォールバック。
  let bearer=SUPABASE_KEY;
  try{
    const tk=await getAccessToken();
    if(tk)bearer=tk;
  }catch(_){}
  return fetch(SUPABASE_URL+path,{
    ...opt,
    headers:{"apikey":SUPABASE_KEY,"Authorization":"Bearer "+bearer,"Content-Type":"application/json",...(opt.headers||{})},
  });
};

// ── 管理者(admins)管理 ────────────────────────────────────────────────────────
// メールアドレスで管理者を登録・判定する方式
const sbListAdmins = async () => {
  const res = await sbFetch('/rest/v1/admins?select=email&order=email.asc');
  return res.json();
};
const sbAddAdmin = async (email) =>
  sbFetch('/rest/v1/admins', {
    method: 'POST',
    headers: { 'Prefer': 'return=minimal' },
    body: JSON.stringify({ email }),
  });
const sbRemoveAdmin = async (email) =>
  sbFetch('/rest/v1/admins?email=eq.' + encodeURIComponent(email), {
    method: 'DELETE',
    headers: { 'Prefer': 'return=minimal' },
  });

// ── 複数世代バックアップ ──────────────────────────────────────────────────────
const sbSaveBackup = async (data, label) =>
  sbFetch('/rest/v1/timetable_backups', {
    method: 'POST',
    headers: { 'Prefer': 'return=minimal' },
    body: JSON.stringify({ data, label }),
  });

const sbListBackups = async () => {
  // ピン済み（ラベルが 📌 で始まる）は件数制限なしで全取得し、加えて最新30件を取得して結合する。
  // こうしないと、自動バックアップが増えたとき古いピン済みが「最新N件」の枠から押し出されて
  // 一覧から消えてしまう（＝固定したはずのバックアップが見えなくなる）。
  const pinQ = encodeURIComponent('📌') + '*'; // PostgREST の like は * をワイルドカードとして扱う
  const [pinnedRes, recentRes] = await Promise.all([
    sbFetch(`/rest/v1/timetable_backups?label=like.${pinQ}&order=created_at.desc`),
    sbFetch('/rest/v1/timetable_backups?order=created_at.desc&limit=30'),
  ]);
  const pinned = await pinnedRes.json();
  const recent = await recentRes.json();
  // どちらかがエラーオブジェクト（配列でない）なら、取得できた方を返す（モーダル側でエラー表示）
  if (!Array.isArray(pinned) || !Array.isArray(recent)) {
    return Array.isArray(recent) ? recent : pinned;
  }
  // id で重複排除して結合（ピン済みが最新30件にも含まれる場合の二重を防ぐ）
  const byId = new Map();
  for (const r of [...pinned, ...recent]) byId.set(r.id, r);
  return [...byId.values()];
};

const sbRestoreBackup = async (id) => {
  const res = await sbFetch(`/rest/v1/timetable_backups?id=eq.${id}`);
  const rows = await res.json();
  return rows[0]?.data || null;
};

const sbDeleteBackup = async (id) =>
  sbFetch(`/rest/v1/timetable_backups?id=eq.${id}`, { method: 'DELETE' });

// ── トークン管理 ──────────────────────────────────────────────────────────────
const sbSaveToken=async(token,type,classId=null)=>
  sbFetch('/rest/v1/timetable_tokens',{
    method:'POST',
    headers:{'Prefer':'return=minimal'},
    body:JSON.stringify({token,type,class_id:classId}),
  });

const sbGetToken=async(token)=>{
  const res=await sbFetch(`/rest/v1/timetable_tokens?token=eq.${token}`);
  const rows=await res.json();
  return rows[0]||null;
};

const sbListTokens=async()=>{
  const res=await sbFetch('/rest/v1/timetable_tokens?order=created_at.desc');
  return res.json();
};

const sbDeleteToken=async(token)=>
  sbFetch(`/rest/v1/timetable_tokens?token=eq.${token}`,{method:'DELETE'});

// ── 公開データ管理 ────────────────────────────────────────────────────────────
const sbPublish=async(data)=>
  sbFetch('/rest/v1/timetable_published?id=eq.main',{
    method:'PATCH',
    headers:{'Prefer':'return=minimal'},
    body:JSON.stringify({data,published_at:new Date().toISOString()}),
  }).then(async res=>{
    // PATCH で 0 rows の場合は INSERT
    if(res.status===404||res.status===200&&(await res.clone().text())===''){
      return sbFetch('/rest/v1/timetable_published',{
        method:'POST',
        headers:{'Prefer':'return=minimal'},
        body:JSON.stringify({id:'main',data,published_at:new Date().toISOString()}),
      });
    }
  });

const sbGetPublished=async()=>{
  const res=await sbFetch('/rest/v1/timetable_published?id=eq.main');
  const rows=await res.json();
  return rows[0]?.data||null;
};

const genToken=()=>Math.random().toString(36).slice(2,10)+Math.random().toString(36).slice(2,6);

const shortenUrl=async(url)=>{
  try{
    const res=await fetch(`https://xgd.io/V1/shorten?key=6c3c4298044075748ee788401b7cefd2&url=${encodeURIComponent(url)}&analytics=false`);
    if(res.ok){
      const json=await res.json();
      if(json.shorturl)return json.shorturl;
    }
  }catch(_){}
  return url;
};
const GOOGLE_CLIENT_ID="31518455298-i37bj8u4u0mtb97cs26e1e23angk87rr.apps.googleusercontent.com";
const ALLOWED_DOMAINS=["tonami-city.ed.jp","p1.coralnet.or.jp"];


function LoginScreen({onLogin}){
  const[error,setError]=React.useState("");
  const[loading,setLoading]=React.useState(false);

  const handleGoogleLogin=async()=>{
    setLoading(true);
    setError("");
    try{
      const sb=await getSupabaseClient();
      const{error:err}=await sb.auth.signInWithOAuth({
        provider:"google",
        options:{
          redirectTo:window.location.origin,
          queryParams:{prompt:"select_account"},
        },
      });
      if(err){
        setError("ログインに失敗しました。もう一度お試しください。");
        setLoading(false);
      }
      // 成功時はGoogleの同意画面へリダイレクトするので、ここでは何もしない
    }catch(e){
      setError("ログイン処理を開始できませんでした。通信環境をご確認ください。");
      setLoading(false);
    }
  };

  return(
    <div style={{minHeight:"100vh",background:"#F0F4F8",display:"flex",alignItems:"center",justifyContent:"center",fontFamily:"'Noto Sans JP','Hiragino Sans',sans-serif"}}>
      <div style={{background:"white",borderRadius:16,padding:"48px 40px",boxShadow:"0 8px 32px rgba(0,0,0,0.12)",textAlign:"center",maxWidth:360,width:"90%"}}>
        <div style={{fontSize:48,marginBottom:16}}>📚</div>
        <div style={{fontSize:20,fontWeight:700,color:"#1E3A5F",marginBottom:8}}>時間割管理システム</div>
        <div style={{fontSize:13,color:"#64748B",marginBottom:32}}>
          {ALLOWED_DOMAINS.length?"許可されたGoogleアカウントでログインしてください":"Googleアカウントでログインしてください"}
        </div>
        {loading
          ?<div style={{color:"#64748B",fontSize:13}}>ログイン中...</div>
          :<button onClick={handleGoogleLogin}
              style={{display:"inline-flex",alignItems:"center",gap:10,background:"white",
                border:"1.5px solid #DADCE0",borderRadius:8,padding:"10px 20px",fontSize:14,
                fontWeight:600,color:"#3C4043",cursor:"pointer",fontFamily:"inherit"}}>
              <svg width="18" height="18" viewBox="0 0 18 18"><path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62z"/><path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.02-3.7H.96v2.34A9 9 0 0 0 9 18z"/><path fill="#FBBC05" d="M3.98 10.72a5.4 5.4 0 0 1 0-3.44V4.94H.96a9 9 0 0 0 0 8.12l3.02-2.34z"/><path fill="#EA4335" d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58A9 9 0 0 0 9 0 9 9 0 0 0 .96 4.94l3.02 2.34C4.68 5.16 6.66 3.58 9 3.58z"/></svg>
              Googleでログイン
            </button>
        }
        {error&&(
          <div style={{marginTop:16,padding:"10px 14px",background:"#FEE2E2",borderRadius:8,fontSize:12,color:"#DC2626",whiteSpace:"pre-line"}}>
            {error}
          </div>
        )}
      </div>
    </div>
  );
}

export function AuthWrapper(){
  // 体験モード: ログイン不要でデモユーザーとして直接起動
  if(IS_DEMO){
    return <App user={{email:"demo@example.com",name:"体験ユーザー"}} onLogout={null}
      classParam={null} modeParam={null} isAdmin={true} isDemo={true}/>;
  }
  const saved=sessionStorage.getItem("gUser");
  const[user,setUser]=React.useState(saved?JSON.parse(saved):null);
  const[authReady,setAuthReady]=React.useState(false);
  const[isAdmin,setIsAdmin]=React.useState(false);
  const[adminChecked,setAdminChecked]=React.useState(false);
  const[tokenInfo,setTokenInfo]=React.useState(null); // {type:"student"|"teacher", classId}
  const[tokenChecked,setTokenChecked]=React.useState(false);
  const params=new URLSearchParams(window.location.search);
  const classParam=params.get("class")||null;
  const modeParam=params.get("mode")||null;
  const tokenParam=params.get("t")||null;

  // Supabase Auth のセッションを監視。ログイン状態の真実はここから取る。
  React.useEffect(()=>{
    if(tokenParam)return; // トークンビューはAuth不要
    let unsub=null;
    (async()=>{
      try{
        const sb=await getSupabaseClient();
        const applySession=async(session)=>{
          if(session?.user){
            const email=session.user.email||"";
            const domain=email.split("@")[1]||"";
            // ドメイン制限（許可外なら即サインアウト）
            if(ALLOWED_DOMAINS.length&&!ALLOWED_DOMAINS.includes(domain)){
              await sb.auth.signOut();
              setUser(null);setIsAdmin(false);setAdminChecked(true);setAuthReady(true);
              return;
            }
            const u={email,name:session.user.user_metadata?.name||email,picture:session.user.user_metadata?.picture||null,id:session.user.id};
            setUser(u);
            // 管理者判定: admins テーブルに自分の email があるか（メールベース）
            try{
              const{data}=await sb.from("admins").select("email").eq("email",email).maybeSingle();
              setIsAdmin(!!data);
            }catch(_){setIsAdmin(false);}
            setAdminChecked(true);
          }else{
            setUser(null);setIsAdmin(false);setAdminChecked(true);
          }
          setAuthReady(true);
        };
        const{data:{session}}=await sb.auth.getSession();
        await applySession(session);
        const{data:sub}=sb.auth.onAuthStateChange((_evt,session)=>{applySession(session);});
        unsub=sub?.subscription;
      }catch(e){
        setAuthReady(true);setAdminChecked(true);
      }
    })();
    return()=>{try{unsub&&unsub.unsubscribe();}catch(_){}};
  },[tokenParam]);

  // トークンチェック
  React.useEffect(()=>{
    if(!tokenParam){setTokenChecked(true);return;}
    sbGetToken(tokenParam).then(info=>{
      if(info)setTokenInfo({type:info.type,classId:info.class_id});
      setTokenChecked(true);
    }).catch(()=>setTokenChecked(true));
  },[tokenParam]);

  if(!tokenChecked) return(
    <div style={{minHeight:"100vh",display:"flex",alignItems:"center",justifyContent:"center",fontFamily:"sans-serif",color:"#64748B"}}>
      読み込み中...
    </div>
  );

  // トークンアクセス → Google認証不要
  if(tokenParam&&tokenInfo){
    return <App user={null} onLogout={null} classParam={tokenInfo.classId} modeParam={tokenInfo.type} isAdmin={false} tokenType={tokenInfo.type} usePublished={true}/>;
  }
  // トークンが無効
  if(tokenParam&&!tokenInfo){
    return(
      <div style={{minHeight:"100vh",display:"flex",alignItems:"center",justifyContent:"center",fontFamily:"sans-serif",color:"#64748B",flexDirection:"column",gap:12}}>
        <div style={{fontSize:48}}>🔒</div>
        <div style={{fontWeight:700,fontSize:18,color:"#1E293B"}}>URLが無効です</div>
        <div style={{fontSize:13,color:"#94A3B8"}}>正しいURLをご確認ください</div>
      </div>
    );
  }

  if(!authReady) return(
    <div style={{minHeight:"100vh",display:"flex",alignItems:"center",justifyContent:"center",fontFamily:"sans-serif",color:"#64748B"}}>
      認証確認中...
    </div>
  );
  if(!user) return <LoginScreen onLogin={u=>setUser(u)}/>;
  if(!adminChecked) return(
    <div style={{minHeight:"100vh",display:"flex",alignItems:"center",justifyContent:"center",fontFamily:"sans-serif",color:"#64748B"}}>
      認証確認中...
    </div>
  );
  return <App user={user} onLogout={async()=>{try{const sb=await getSupabaseClient();await sb.auth.signOut();}catch(_){}sessionStorage.removeItem("gUser");setUser(null);setIsAdmin(false);}} classParam={classParam} modeParam={modeParam} isAdmin={isAdmin}/>;
}

// ── Colors ────────────────────────────────────────────────────────────────────
const SC={"国語":"#FDE8E8","数学":"#DBEAFE","英語":"#D1FAE5","理科":"#DCFCE7","社会":"#FEF9C3","音楽":"#EDE9FE","美術":"#FEE2CC","体育":"#BAE6FD","技術":"#CCFBF1","家庭":"#FCE7F3","道徳":"#E0F2FE","学活":"#F3E8FF","総合":"#FEF3C7","生活":"#ECFDF5","自立":"#E0F7FA","図工":"#FFFBEB"};
const gc=s=>SC[s]||"#F8F8F8";

const INIT_CLASSES=[
  {id:"1-1",name:"1年1組"},{id:"1-2",name:"1年2組"},{id:"1-3",name:"1年3組"},
  {id:"2-1",name:"2年1組"},{id:"2-2",name:"2年2組"},{id:"特支1",name:"特支1組"},
];
const INIT_SUBJ=["国語","数学","英語","理科","社会","音楽","美術","体育","技術","家庭","道徳","学活","総合","生活","自立","図工"];
const INIT_WEEKLY={
  "1-1":{"国語":4,"数学":4,"英語":4,"理科":3,"社会":3,"音楽":1,"美術":1,"体育":3,"技術":1,"家庭":1,"道徳":1,"学活":1,"総合":1},
  "1-2":{"国語":4,"数学":4,"英語":4,"理科":3,"社会":3,"音楽":1,"美術":1,"体育":3,"技術":1,"家庭":1,"道徳":1,"学活":1,"総合":1},
};

const DAYS=["月","火","水","木","金"];
const DAYS7=["月","火","水","木","金","土","日"];
const PERIODS=[1,2,3,4,5,6];
const MTG_TYPE_COLORS={"学年部会":"#7C3AED","校務運営委員会":"#065F46","教科部会":"#1D4ED8","その他":"#475569"};

// 教員の出勤可否判定（unavailableSlots: ["金-1","水-3",...] 形式）
const isSlotAvailable=(teacher,day,period,date=null,overrides=[])=>{
  if(!teacher)return true;
  // 特定日・特定時限のオーバーライド（非常勤が特定日だけ出勤）
  if(date&&overrides.some(o=>o.teacherId===teacher.id&&o.date===date&&(o.period===null||o.period===period))) return true;
  // 旧 availableDays との互換性
  if(teacher.availableDays&&!teacher.availableDays.includes(day))return false;
  // 新 unavailableSlots（時限レベル）
  if(teacher.unavailableSlots?.includes(`${day}-${period}`))return false;
  return true;
};
// 指定曜日のすべての時限が不在かどうか
const isDayFullyAbsent=(teacher,day)=>PERIODS.every(p=>!isSlotAvailable(teacher,day,p));

const localStr=d=>`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
const todayStr=()=>localStr(new Date());
const getMon=ds=>{const d=new Date(ds+"T00:00:00"),w=d.getDay();d.setDate(d.getDate()+(w===0?-6:1-w));return localStr(d);};
const addD=(ds,n)=>{const d=new Date(ds+"T00:00:00");d.setDate(d.getDate()+n);return localStr(d);};
const wkDates=m=>Array.from({length:5},(_,i)=>addD(m,i));
const wkDates7=m=>Array.from({length:7},(_,i)=>addD(m,i));
const fmtMD=ds=>{const d=new Date(ds+"T00:00:00");return`${d.getMonth()+1}/${d.getDate()}`;};
const fmtWeek=(m,weekend=false)=>{const s=new Date(m+"T00:00:00"),e=new Date(addD(m,weekend?6:4)+"T00:00:00");return`${s.getFullYear()}年 ${s.getMonth()+1}/${s.getDate()}（月）〜${e.getMonth()+1}/${e.getDate()}（${weekend?"日":"金"}）`;};
const dowOf=ds=>{const w=new Date(ds+"T00:00:00").getDay();if(w>=1&&w<=5)return DAYS[w-1];if(w===6)return"土";if(w===0)return"日";return null;};
const isWeekendDay=d=>d==="土"||d==="日";

// パルスアニメーション用CSSを1回だけ挿入
if(typeof document!=="undefined"&&!document.getElementById("conflict-pulse-style")){
  const s=document.createElement("style");
  s.id="conflict-pulse-style";
  s.textContent=`
    @keyframes conflictPulse {
      0%   { outline: 3px solid #EF4444; outline-offset: 0px; box-shadow: 0 0 0 0 rgba(239,68,68,0.6); }
      50%  { outline: 3px solid #EF4444; outline-offset: 2px; box-shadow: 0 0 0 6px rgba(239,68,68,0); }
      100% { outline: 3px solid #EF4444; outline-offset: 0px; box-shadow: 0 0 0 0 rgba(239,68,68,0); }
    }
    .conflict-pulse {
      animation: conflictPulse 0.8s ease-in-out infinite !important;
      background: #FEE2E2 !important;
      z-index: 5;
    }
    /* 候補ハイライトのパルス: 疑似要素オーバーレイで最前面に描く。
       常時ハイライト(.trial-*)が outline:!important を使うため、アニメより優先されてしまう。
       そこで td 自体の outline では戦わず、::before の独立レイヤーにリングを描いて確実に見せる。 */
    td.candidate-target-pulse, td.candidate-from-pulse, td.candidate-both-pulse { position: relative; }
    td.candidate-target-pulse::before,
    td.candidate-from-pulse::before,
    td.candidate-both-pulse::before {
      content: ""; position: absolute; inset: 0; pointer-events: none;
      z-index: 9; border-radius: 2px;
    }
    /* リング＋塗りを不透明度で明滅させる。常時ハイライト(.trial-*)の outline:!important や
       セルの overflow クリップに埋もれず、どのセルでも確実に点滅が見えるようにする。 */
    @keyframes candPulseFade { 0%,100% { opacity: 1; } 50% { opacity: 0.3; } }
    td.candidate-target-pulse::before { animation: candPulseFade 0.7s ease-in-out infinite; box-shadow: inset 0 0 0 4px #16A34A; background: rgba(22,163,74,0.22); }
    td.candidate-from-pulse::before   { animation: candPulseFade 0.7s ease-in-out infinite; box-shadow: inset 0 0 0 4px #D97706; background: rgba(217,119,6,0.24); }
    td.candidate-both-pulse::before   { animation: candPulseFade 0.7s ease-in-out infinite; box-shadow: inset 0 0 0 4px #2563EB; background: rgba(37,99,235,0.24); }
    /* 【v8_7_24】ホバー用の直接ハイライト（状態を更新せずDOMで当てる。再描画が起きず点滅が安定する） */
    td.hover-target-pulse { position: relative; }
    td.hover-target-pulse::before { content:""; position:absolute; inset:0; pointer-events:none; z-index:9; border-radius:2px; animation: candPulseFade 0.7s ease-in-out infinite; box-shadow: inset 0 0 0 4px #16A34A; background: rgba(22,163,74,0.22); }
    /* トライアルパネル中の常時ハイライト: 移動した駒の移動先（主役・青） */
    .trial-target-cell {
      outline: 3px solid #2563EB !important;
      outline-offset: -1px !important;
      box-shadow: inset 0 0 0 9999px rgba(37,99,235,0.10) !important;
      z-index: 4;
    }
    .trial-target-cell::after {
      content: "📍 移動先";
      position: absolute; top: 1px; right: 1px;
      background: #2563EB; color: #fff; font-size: 8px; font-weight: 700;
      padding: 1px 4px; border-radius: 0 0 0 5px; line-height: 1.3; z-index: 7;
      pointer-events: none;
    }
    /* トライアルパネル中の常時ハイライト: 重複相手の現在地（オレンジ） */
    .trial-conflict-cell {
      outline: 3px solid #EA580C !important;
      outline-offset: -1px !important;
      box-shadow: inset 0 0 0 9999px rgba(234,88,12,0.10) !important;
      z-index: 4;
    }
    .trial-conflict-cell::after {
      content: "⚠ 重複相手";
      position: absolute; top: 1px; right: 1px;
      background: #EA580C; color: #fff; font-size: 8px; font-weight: 700;
      padding: 1px 4px; border-radius: 0 0 0 5px; line-height: 1.3; z-index: 7;
      pointer-events: none;
    }
    /* トライアルパネル中の常時ハイライト: 移動元（出発地・グレー系点線） */
    .trial-source-cell {
      outline: 2px dashed #64748B !important;
      outline-offset: -1px !important;
      box-shadow: inset 0 0 0 9999px rgba(100,116,139,0.08) !important;
      z-index: 3;
    }
    .trial-source-cell::after {
      content: "↩ 移動元";
      position: absolute; top: 1px; right: 1px;
      background: #64748B; color: #fff; font-size: 8px; font-weight: 700;
      padding: 1px 4px; border-radius: 0 0 0 5px; line-height: 1.3; z-index: 7;
      pointer-events: none;
    }
  `;
  document.head.appendChild(s);
}

// A/B週判定: abWeekBase(A週の基準月曜)からwkStart(今週月曜)までの週数で判定
// 0週目=A週, 1週目=B週, 2週目=A週...
const getABWeek=(wkStart,abWeekBase)=>{
  if(!abWeekBase||!wkStart)return null; // 未設定
  const base=new Date(abWeekBase+"T00:00:00");
  const cur=new Date(wkStart+"T00:00:00");
  const diff=Math.round((cur-base)/(7*24*60*60*1000));
  return diff%2===0?"A":"B"; // 偶数週=A, 奇数週=B
};

const INIT_T=[
  {id:"T01",name:"田中",asgn:[{c:"1-1",s:"国語",n:4},{c:"1-2",s:"国語",n:4},{c:"1-1",s:"道徳",n:1},{c:"1-2",s:"道徳",n:1}]},
  {id:"T02",name:"山田",asgn:[{c:"1-1",s:"数学",n:4},{c:"1-2",s:"数学",n:4},{c:"1-3",s:"数学",n:4},{c:"2-1",s:"数学",n:4},{c:"2-2",s:"数学",n:4}]},
  {id:"T03",name:"鈴木",asgn:[{c:"1-1",s:"英語",n:4},{c:"1-2",s:"英語",n:4},{c:"1-3",s:"英語",n:4},{c:"2-1",s:"英語",n:4},{c:"2-2",s:"英語",n:4}]},
  {id:"T04",name:"佐藤",asgn:[{c:"1-1",s:"理科",n:3},{c:"2-1",s:"理科",n:3},{c:"1-1",s:"社会",n:3},{c:"2-1",s:"社会",n:3}]},
  {id:"T05",name:"高橋",asgn:[{c:"1-1",s:"体育",n:3},{c:"1-2",s:"体育",n:3},{c:"1-3",s:"体育",n:3},{c:"2-1",s:"体育",n:3},{c:"2-2",s:"体育",n:3},{c:"特支1",s:"体育",n:2}]},
  {id:"T06",name:"伊藤",asgn:[{c:"1-1",s:"音楽",n:1},{c:"1-2",s:"音楽",n:1},{c:"1-3",s:"音楽",n:1},{c:"2-1",s:"音楽",n:1},{c:"1-1",s:"美術",n:1},{c:"1-2",s:"美術",n:1},{c:"1-1",s:"家庭",n:1},{c:"1-2",s:"家庭",n:1},{c:"1-1",s:"総合",n:1},{c:"1-1",s:"学活",n:1},{c:"1-2",s:"学活",n:1},{c:"特支1",s:"音楽",n:1}]},
  {id:"T07",name:"中村",asgn:[{c:"特支1",s:"国語",n:5},{c:"特支1",s:"数学",n:5},{c:"特支1",s:"生活",n:4},{c:"特支1",s:"自立",n:3},{c:"特支1",s:"道徳",n:1},{c:"特支1",s:"学活",n:1}]},
];

function genBase(){
  let id=1;const e=(day,period,classIds,teacherIds,subject)=>({id:id++,day,period,classIds,teacherIds,subject});
  return[
    e("月",1,["1-1"],["T01"],"国語"),e("月",2,["1-1"],["T02"],"数学"),e("月",3,["1-1"],["T03"],"英語"),
    e("月",4,["1-1","1-2"],["T05"],"体育"),
    e("月",5,["1-1"],["T04"],"理科"),e("月",6,["1-1"],["T01"],"道徳"),
    e("火",1,["1-1"],["T02"],"数学"),e("火",2,["1-1"],["T03"],"英語"),e("火",3,["1-1"],["T04"],"社会"),
    e("火",4,["1-1"],["T06"],"音楽"),e("火",5,["1-1"],["T01"],"国語"),e("火",6,["1-1"],["T06"],"学活"),
    e("水",1,["1-1"],["T03"],"英語"),e("水",2,["1-1"],["T04"],"理科"),e("水",3,["1-1"],["T02"],"数学"),
    e("水",4,["1-1"],["T06"],"美術"),
    e("水",5,["1-1","1-2"],["T05"],"体育"),
    e("水",6,["1-1"],["T01"],"国語"),
    e("木",1,["1-1"],["T04"],"社会"),e("木",2,["1-1"],["T01"],"国語"),e("木",3,["1-1"],["T03"],"英語"),
    e("木",4,["1-1"],["T02"],"数学"),
    e("木",5,["1-1"],["T05","T06"],"家庭"),
    e("木",6,["1-1"],["T06"],"総合"),
    e("金",1,["1-1"],["T03"],"英語"),e("金",2,["1-1"],["T04"],"理科"),e("金",3,["1-1"],["T02"],"数学"),
    e("金",4,["1-1"],["T01"],"道徳"),e("金",5,["1-1"],["T06"],"音楽"),e("金",6,["1-1"],["T01"],"国語"),
    e("月",1,["1-2"],["T02"],"数学"),e("月",2,["1-2"],["T01"],"国語"),e("月",3,["1-2"],["T06"],"音楽"),
    e("月",5,["1-2"],["T03"],"英語"),e("月",6,["1-2"],["T06"],"学活"),
    e("火",1,["1-2"],["T03"],"英語"),e("火",2,["1-2"],["T02"],"数学"),e("火",3,["1-2"],["T01"],"国語"),
    e("火",4,["1-2"],["T06"],"美術"),e("火",5,["1-2"],["T06"],"家庭"),e("火",6,["1-2"],["T01"],"道徳"),
    e("水",1,["1-2"],["T02"],"数学"),e("水",2,["1-2"],["T03"],"英語"),e("水",3,["1-2"],["T06"],"総合"),
    e("水",4,["1-2"],["T01"],"国語"),e("水",6,["1-2"],["T06"],"学活"),
    e("木",1,["1-2"],["T01"],"国語"),e("木",2,["1-2"],["T06"],"音楽"),e("木",3,["1-2"],["T02"],"数学"),
    e("木",4,["1-2"],["T03"],"英語"),e("木",5,["1-2"],["T01"],"道徳"),e("木",6,["1-2"],["T06"],"美術"),
    e("金",1,["1-2"],["T02"],"数学"),e("金",2,["1-2"],["T01"],"国語"),e("金",3,["1-2"],["T03"],"英語"),
    e("金",4,["1-2"],["T06"],"家庭"),e("金",5,["1-2"],["T02"],"数学"),e("金",6,["1-2"],["T01"],"道徳"),
    e("月",1,["特支1"],["T07"],"国語"),e("月",2,["特支1"],["T07"],"数学"),e("月",3,["特支1"],["T07"],"生活"),
    e("月",4,["特支1"],["T07"],"生活"),e("月",5,["特支1"],["T07"],"自立"),e("月",6,["特支1"],["T07"],"道徳"),
    e("火",1,["特支1"],["T07"],"国語"),e("火",2,["特支1"],["T07"],"数学"),e("火",3,["特支1"],["T07"],"生活"),
    e("火",4,["特支1"],["T07"],"自立"),e("火",5,["特支1"],["T05"],"体育"),e("火",6,["特支1"],["T07"],"学活"),
    e("水",1,["特支1"],["T07"],"国語"),e("水",2,["特支1"],["T07"],"数学"),e("水",3,["特支1"],["T07"],"生活"),
    e("水",4,["特支1"],["T05"],"体育"),e("水",5,["特支1"],["T07"],"自立"),e("水",6,["特支1"],["T07"],"道徳"),
    e("木",1,["特支1"],["T07"],"国語"),e("木",2,["特支1"],["T07"],"数学"),e("木",3,["特支1"],["T07"],"生活"),
    e("木",4,["特支1"],["T06"],"音楽"),e("木",5,["特支1"],["T07"],"自立"),e("木",6,["特支1"],["T07"],"学活"),
    e("金",1,["特支1"],["T07"],"国語"),e("金",2,["特支1"],["T07"],"数学"),e("金",3,["特支1"],["T07"],"生活"),
    e("金",4,["特支1"],["T07"],"生活"),e("金",5,["特支1"],["T07"],"自立"),e("金",6,["特支1"],["T07"],"学活"),
  ];
}

// ── 体験版データ（庄川中の実構造を匿名化: 学校名/学級名/教師名のみダミー。ID・時間割・合同・通級・会議は実物）──
const DEMO_DATA={"schoolName":"みどり野中学校（体験版）","classes":[{"id":"1-1","name":"1年A組"},{"id":"2-1","name":"2年A組"},{"id":"特支1","name":"つばさ2年"},{"id":"c1777991594895","name":"ひまわり2年"},{"id":"2-2","name":"3年A組"},{"id":"c1777991582711","name":"つばさ3年"},{"id":"c1777991605023","name":"ひまわり3年"},{"id":"c1778042181266","name":"通級1年"},{"id":"c1778042184836","name":"通級2年A"},{"id":"c1778042189316","name":"通級2年B"},{"id":"c1778042260582","name":"通級3年"},{"id":"c1779948886215","name":"アップ"}],"teachers":[{"id":"T01","name":"森田","asgn":[{"c":"2-2","n":3,"s":"国語"},{"c":"1-1","n":4,"s":"国語"}]},{"id":"T41783","name":"大西","asgn":[{"c":"1-1","n":3,"s":"体育"},{"c":"2-1","n":3,"s":"体育"},{"c":"c1777991605023","n":1,"s":"理科"},{"c":"c1777991605023","n":3,"s":"英語"},{"c":"c1777991594895","n":3,"s":"英語"},{"c":"c1777991594895","n":3,"s":"数学"},{"c":"c1777991605023","n":3,"s":"数学"}]},{"id":"T05","name":"林","asgn":[{"c":"1-1","n":3,"s":"理科"},{"c":"c1777991605023","n":3,"s":"社会"},{"c":"特支1","n":1,"s":"国語"},{"c":"1-1","n":1,"s":"道徳"},{"c":"1-1","n":2,"s":"総合"},{"c":"c1777991594895","n":3,"s":"社会"},{"c":"2-2","n":5,"s":"理科"}]},{"id":"T03","name":"岡本","asgn":[{"c":"1-1","n":3,"s":"社会"},{"c":"2-1","n":3,"s":"社会"},{"c":"2-2","n":4,"s":"社会"},{"c":"c1777991594895","n":1,"s":"理科"},{"c":"c1777991605023","n":1,"s":"社会"},{"c":"1-1","n":1,"s":"特別活動"},{"c":"1-1","n":1,"s":"道徳"},{"c":"1-1","n":2,"s":"総合"},{"c":"c1779948886215","n":2,"s":"自立"}]},{"id":"T02","name":"清水","asgn":[{"c":"2-1","n":4,"s":"国語"},{"c":"c1777991594895","n":4,"s":"国語"},{"c":"c1777991594895","n":3,"s":"理科"},{"c":"c1777991594895","n":1,"s":"自立"},{"c":"c1777991605023","n":1,"s":"自立"},{"c":"c1777991594895","n":1,"s":"特別活動"},{"c":"c1777991605023","n":1,"s":"特別活動"},{"c":"c1777991594895","n":1,"s":"総合"},{"c":"c1777991605023","n":1,"s":"総合"},{"c":"c1777991605023","n":3,"s":"国語"},{"c":"c1777991605023","n":4,"s":"理科"}]},{"id":"T07","name":"西村","asgn":[{"c":"1-1","n":2,"s":"音楽"},{"c":"2-1","n":1,"s":"音楽"},{"c":"2-2","n":1,"s":"音楽"},{"c":"c1777991582711","n":3,"s":"国語"},{"c":"特支1","n":3,"s":"国語"},{"c":"2-1","n":1,"s":"特別活動"},{"c":"2-1","n":1,"s":"道徳"},{"c":"2-1","n":2,"s":"総合"},{"c":"特支1","n":3,"s":"社会"},{"c":"c1777991582711","n":5,"s":"社会"},{"c":"c1779948886215","n":2,"s":"自立"}]},{"id":"T06","name":"中島","asgn":[{"c":"2-1","n":4,"s":"理科"},{"c":"c1777991605023","n":1,"s":"数学"},{"c":"2-1","n":1,"s":"道徳"},{"c":"c1778042181266","n":2,"s":"自立"},{"c":"c1778042189316","n":1,"s":"自立"},{"c":"c1778042260582","n":2,"s":"自立"},{"c":"c1778042184836","n":2,"s":"自立"}]},{"id":"T64123","name":"石川","asgn":[{"c":"1-1","n":4,"s":"英語"},{"c":"2-1","n":4,"s":"英語"},{"c":"2-2","n":4,"s":"英語"},{"c":"2-2","n":1,"s":"道徳"},{"c":"2-2","n":2,"s":"総合"},{"c":"c1779948886215","n":2,"s":"自立"}]},{"id":"T04","name":"河野","asgn":[{"c":"1-1","n":4,"s":"数学"},{"c":"2-1","n":3,"s":"数学"},{"c":"2-2","n":4,"s":"数学"},{"c":"c1777991582711","n":1,"s":"数学"},{"c":"2-2","n":1,"s":"特別活動"},{"c":"2-2","n":1,"s":"道徳"},{"c":"2-2","n":2,"s":"総合"}]},{"id":"T45259","name":"横山","asgn":[{"c":"2-2","n":3,"s":"体育"},{"c":"特支1","n":1,"s":"特別活動"},{"c":"c1777991582711","n":1,"s":"特別活動"},{"c":"特支1","n":1,"s":"自立"},{"c":"c1777991582711","n":1,"s":"自立"},{"c":"特支1","n":1,"s":"作業"},{"c":"c1777991582711","n":1,"s":"作業"},{"c":"c1777991582711","n":3,"s":"英語"},{"c":"特支1","n":3,"s":"英語"},{"c":"特支1","n":3,"s":"理科"},{"c":"c1777991582711","n":3,"s":"理科"},{"c":"特支1","n":3,"s":"数学"},{"c":"c1777991582711","n":3,"s":"数学"},{"c":"特支1","n":1,"s":"道徳"},{"c":"c1777991582711","n":1,"s":"道徳"}]},{"id":"T49453","name":"上田","asgn":[{"c":"1-1","n":1,"s":"技術"},{"c":"2-1","n":1,"s":"技術"},{"c":"2-2","n":1,"s":"技術"}]},{"id":"T37619","name":"木下","asgn":[{"c":"1-1","n":2,"s":"美術"},{"c":"2-1","n":1,"s":"美術"},{"c":"2-2","n":1,"s":"美術"}]},{"id":"T59147","name":"藤井","asgn":[{"c":"1-1","n":1,"s":"家庭"},{"c":"2-1","n":1,"s":"家庭"},{"c":"2-2","n":1,"s":"家庭"}]},{"id":"T51994","name":"スミス","asgn":[{"c":"1-1","n":4,"s":"英語"},{"c":"2-1","n":4,"s":"英語"},{"c":"2-2","n":3,"s":"英語"},{"c":"特支1","n":1,"s":"英語"},{"c":"c1777991582711","n":1,"s":"英語"},{"c":"c1777991594895","n":1,"s":"英語"},{"c":"c1777991605023","n":1,"s":"英語"}]}],"subjects":["国語","社会","数学","理科","英語","音楽","美術","体育","技術","家庭","道徳","総合","特別活動","自立","作業"],"base":[{"id":1,"day":"月","note":"","period":1,"subject":"英語","classIds":["1-1"],"teacherIds":["T51994","T64123"]},{"id":2,"day":"月","period":2,"subject":"社会","classIds":["1-1"],"teacherIds":["T03"]},{"id":3,"day":"月","period":3,"subject":"体育","classIds":["1-1"],"teacherIds":["T41783"]},{"id":5,"day":"月","period":5,"subject":"理科","classIds":["1-1"],"teacherIds":["T05"]},{"id":8,"day":"火","period":2,"subject":"技術","classIds":["1-1"],"teacherIds":["T49453"]},{"id":10,"day":"火","note":"","period":3,"subject":"国語","classIds":["1-1"],"linkGroup":"lg-1779879346295","teacherIds":["T01"]},{"id":11,"day":"火","period":5,"subject":"音楽","classIds":["1-1"],"teacherIds":["T07"]},{"id":12,"day":"火","period":6,"subject":"理科","classIds":["1-1"],"teacherIds":["T05"]},{"id":13,"day":"水","period":1,"subject":"社会","classIds":["1-1"],"teacherIds":["T03"]},{"id":14,"day":"水","period":2,"subject":"国語","classIds":["1-1"],"teacherIds":["T01"]},{"id":15,"day":"水","period":3,"subject":"体育","classIds":["1-1"],"teacherIds":["T41783"]},{"id":16,"day":"水","period":4,"subject":"総合","classIds":["1-1"],"teacherIds":["T03","T05"]},{"id":17,"day":"火","period":1,"subject":"数学","classIds":["1-1"],"teacherIds":["T04"]},{"id":18,"day":"水","note":"","period":6,"subject":"英語","classIds":["1-1"],"teacherIds":["T51994","T64123"]},{"id":20,"day":"木","note":"","period":2,"altWeek":"A","subject":"美術","classIds":["1-1"],"teacherIds":["T37619"]},{"id":21,"day":"木","period":3,"subject":"美術","classIds":["1-1"],"teacherIds":["T37619"]},{"id":24,"day":"木","period":4,"subject":"家庭","classIds":["1-1"],"teacherIds":["T59147"]},{"id":25,"day":"金","period":1,"subject":"社会","classIds":["1-1"],"teacherIds":["T03"]},{"id":26,"day":"金","period":2,"subject":"体育","classIds":["1-1"],"teacherIds":["T41783"]},{"id":27,"day":"金","period":3,"subject":"理科","classIds":["1-1"],"teacherIds":["T05"]},{"id":28,"day":"金","period":4,"subject":"国語","classIds":["1-1"],"teacherIds":["T01"]},{"id":29,"day":"金","period":5,"subject":"数学","classIds":["1-1"],"teacherIds":["T04"]},{"id":30,"day":"金","period":6,"subject":"特別活動","classIds":["1-1"],"teacherIds":["T03","T05"]},{"id":1778043238310,"day":"月","note":"","period":2,"subject":"英語","classIds":["2-1"],"teacherIds":["T51994","T64123"]},{"id":1778043250189,"day":"月","period":4,"subject":"道徳","classIds":["2-1","c1777991594895"],"teacherIds":["T07","T06"]},{"id":1778043255006,"day":"月","note":"","period":5,"subject":"数学","classIds":["2-1"],"linkGroup":"lg-1779879377037","teacherIds":["T04"]},{"id":1778043296669,"day":"火","period":6,"subject":"特別活動","classIds":["2-1"],"teacherIds":["T07","T06"]},{"id":1778043302709,"day":"水","period":1,"subject":"数学","classIds":["2-1"],"teacherIds":["T04"]},{"id":1778043312326,"day":"水","period":2,"subject":"音楽","classIds":["2-1","特支1","c1777991594895"],"teacherIds":["T07"]},{"id":1778043586149,"day":"水","period":3,"subject":"総合","classIds":["2-1","特支1","c1777991594895"],"teacherIds":["T07"]},{"id":1778043588245,"day":"水","period":4,"subject":"総合","classIds":["2-1","特支1"],"_benchDay":"水","teacherIds":["T07"],"_benchPeriod":4},{"id":1778043593269,"day":"火","period":1,"subject":"理科","classIds":["2-1","c1777991594895"],"teacherIds":["T06","T02"]},{"id":1778043595485,"day":"水","period":6,"subject":"国語","classIds":["2-1"],"teacherIds":["T02"]},{"id":1778043600709,"day":"木","period":1,"subject":"国語","classIds":["2-1"],"teacherIds":["T02"]},{"id":1778043603358,"day":"木","period":2,"subject":"家庭","classIds":["2-1","特支1","c1777991594895"],"teacherIds":["T59147"]},{"id":1778043607613,"day":"木","period":3,"subject":"社会","classIds":["2-1"],"teacherIds":["T03"]},{"id":1778043616645,"day":"木","period":5,"subject":"美術","classIds":["2-1","特支1","c1777991594895"],"teacherIds":["T37619"]},{"id":1778043622445,"day":"木","period":4,"subject":"体育","classIds":["2-1","特支1","c1777991594895"],"teacherIds":["T41783"]},{"id":1778043625437,"day":"木","note":"","period":6,"subject":"英語","classIds":["2-1"],"teacherIds":["T51994","T64123"]},{"id":1778043629093,"day":"金","period":1,"subject":"数学","classIds":["2-1"],"teacherIds":["T04"]},{"id":1778043632126,"day":"金","period":2,"subject":"社会","classIds":["2-1"],"teacherIds":["T03"]},{"id":1778043638382,"day":"金","note":"","period":4,"subject":"英語","classIds":["2-1"],"teacherIds":["T51994","T64123"]},{"id":1778043816533,"day":"月","period":1,"subject":"社会","classIds":["2-2"],"teacherIds":["T03"]},{"id":1778043821221,"day":"月","period":2,"subject":"数学","classIds":["2-2"],"teacherIds":["T04"]},{"id":1778043832573,"day":"月","period":4,"subject":"道徳","classIds":["2-2","c1777991605023"],"teacherIds":["T64123","T04"]},{"id":1778043837805,"day":"月","period":5,"subject":"国語","classIds":["2-2"],"teacherIds":["T01"]},{"id":1778043883133,"day":"火","note":"","period":6,"subject":"特別活動","classIds":["2-2"],"teacherIds":["T04","T64123"]},{"id":1778043913117,"day":"水","note":"","period":1,"subject":"英語","classIds":["2-2"],"teacherIds":["T51994","T64123"]},{"id":1778043925229,"day":"水","period":2,"subject":"体育","classIds":["2-2","c1777991582711","c1777991605023"],"teacherIds":["T45259"]},{"id":1778043928781,"day":"水","period":3,"subject":"総合","classIds":["2-2","c1777991582711","c1777991605023"],"teacherIds":["T04","T64123"]},{"id":1778043932149,"day":"水","period":4,"subject":"総合","classIds":["2-2","c1777991582711"],"teacherIds":["T04","T64123"]},{"id":1778043937565,"day":"木","period":4,"subject":"美術","classIds":["2-2","c1777991582711","c1777991605023"],"teacherIds":["T37619"]},{"id":1778043941550,"day":"火","note":"","period":5,"subject":"自立","classIds":["c1778042260582"],"teacherIds":["T06"]},{"id":1778043945405,"day":"水","period":6,"subject":"社会","classIds":["2-2"],"teacherIds":["T03"]},{"id":1778043952749,"day":"木","period":2,"subject":"体育","classIds":["2-2","c1777991582711","c1777991605023"],"teacherIds":["T45259"]},{"id":1778043965533,"day":"木","period":3,"subject":"英語","classIds":["2-2"],"teacherIds":["T64123"]},{"id":1778043968901,"day":"金","period":5,"subject":"理科","classIds":["2-2"],"teacherIds":["T05"]},{"id":1778043999245,"day":"木","period":6,"subject":"数学","classIds":["2-2"],"teacherIds":["T04"]},{"id":1778044008509,"day":"金","period":2,"subject":"数学","classIds":["2-2"],"teacherIds":["T04"]},{"id":1778044013317,"day":"金","period":3,"subject":"音楽","classIds":["2-2","c1777991582711","c1777991605023"],"teacherIds":["T07"]},{"id":1778044017021,"day":"木","period":1,"subject":"社会","classIds":["2-2"],"teacherIds":["T03"]},{"id":1778044026605,"day":"金","period":6,"subject":"国語","classIds":["2-2"],"teacherIds":["T01"]},{"id":1778159467230,"day":"木","period":6,"subject":"国語","classIds":["1-1"],"teacherIds":["T01"]},{"id":1778159505343,"day":"月","period":1,"subject":"国語","classIds":["2-1"],"teacherIds":["T02"]},{"id":1778159535934,"day":"月","period":5,"subject":"国語","classIds":["c1777991605023","c1777991594895"],"teacherIds":["T02"]},{"id":1778159561894,"day":"火","note":"","period":4,"altWeek":"A","subject":"技術","classIds":["2-2"],"teacherIds":["T49453"]},{"id":1778159639686,"day":"水","period":5,"subject":"理科","classIds":["c1777991605023","2-2"],"teacherIds":["T02","T05"]},{"id":1778159730334,"day":"木","note":"","period":5,"altWeek":"B","subject":"家庭","classIds":["2-2"],"teacherIds":["T59147"]},{"id":1778159777582,"day":"木","period":6,"subject":"国語","classIds":["c1777991605023","c1777991594895"],"teacherIds":["T02"]},{"id":1778159784789,"day":"金","period":1,"subject":"自立","classIds":["c1777991605023","c1777991594895"],"teacherIds":["T02"]},{"id":1778159814958,"day":"金","period":4,"subject":"国語","classIds":["c1777991594895"],"teacherIds":["T02"]},{"id":1778159819926,"day":"金","period":5,"subject":"理科","classIds":["c1777991594895","2-1"],"teacherIds":["T02","T06"]},{"id":1778159951902,"day":"月","period":4,"subject":"道徳","classIds":["1-1"],"teacherIds":["T05","T03"]},{"id":1778159997494,"day":"火","note":"","period":3,"subject":"社会","classIds":["c1777991605023","c1777991594895"],"teacherIds":["T03"]},{"id":1778160044175,"day":"水","period":5,"subject":"理科","classIds":["c1777991594895","2-1"],"teacherIds":["T03","T06"]},{"id":1778160206414,"day":"月","note":"","period":3,"subject":"理科","classIds":["2-1"],"teacherIds":["T06"]},{"id":1778160367942,"day":"火","period":5,"subject":"社会","classIds":["2-1"],"teacherIds":["T03"]},{"id":1778160466159,"day":"金","period":4,"subject":"数学","classIds":["c1777991605023"],"teacherIds":["T06"]},{"id":1778386499534,"day":"月","period":1,"subject":"国語","classIds":["特支1","c1777991582711"],"teacherIds":["T07"]},{"id":1778407633219,"day":"水","period":1,"subject":"国語","classIds":["c1777991594895","c1777991605023"],"teacherIds":["T02"]},{"id":1778407672208,"day":"水","period":4,"subject":"総合","classIds":["c1777991594895","c1777991605023"],"teacherIds":["T02"]},{"id":1778407762887,"day":"月","period":1,"subject":"数学","classIds":["c1777991594895","c1777991605023"],"teacherIds":["T41783"]},{"id":1778407784163,"day":"火","period":2,"subject":"数学","classIds":["c1777991594895","c1777991605023"],"linkGroup":"lg-1779952521238","teacherIds":["T41783"]},{"id":1778407795507,"day":"火","period":5,"subject":"英語","classIds":["c1777991594895","c1777991605023"],"teacherIds":["T41783"]},{"id":1778407828684,"day":"水","period":6,"subject":"数学","classIds":["c1777991594895","c1777991605023"],"teacherIds":["T41783"]},{"id":1778407852256,"day":"木","period":1,"subject":"英語","classIds":["c1777991594895","c1777991605023"],"teacherIds":["T41783"]},{"id":1778407935692,"day":"金","period":5,"subject":"理科","classIds":["c1777991605023"],"teacherIds":["T41783"]},{"id":1778407941675,"day":"金","note":"","period":6,"subject":"英語","classIds":["c1777991594895","c1777991605023"],"teacherIds":["T51994","T41783"]},{"id":1778408276531,"day":"木","period":3,"subject":"社会","classIds":["c1777991605023","c1777991594895"],"teacherIds":["T05"]},{"id":1778408336195,"day":"金","period":2,"subject":"社会","classIds":["c1777991605023","c1777991594895"],"teacherIds":["T05"]},{"id":1778408771225,"day":"金","period":4,"subject":"社会","classIds":["2-2"],"teacherIds":["T03"]},{"id":1778408971798,"day":"火","period":4,"subject":"社会","classIds":["c1777991582711"],"teacherIds":["T07"]},{"id":1778585438256,"day":"火","note":"","period":4,"subject":"英語","classIds":["1-1"],"teacherIds":["T51994","T64123"]},{"id":1778585717605,"day":"木","note":"","period":5,"subject":"英語","classIds":["1-1"],"teacherIds":["T51994","T64123"]},{"id":1778586376764,"day":"水","period":5,"subject":"数学","classIds":["1-1"],"teacherIds":["T04"]},{"id":1778838296841,"day":"火","period":2,"subject":"国語","classIds":["2-2"],"teacherIds":["T01"]},{"id":1778838657193,"day":"火","period":1,"subject":"体育","classIds":["2-2","c1777991582711","c1777991605023"],"teacherIds":["T45259"]},{"id":1778838670806,"day":"火","note":"","period":3,"subject":"英語","classIds":["2-2"],"teacherIds":["T51994","T64123"]},{"id":1778911777318,"day":"月","period":2,"subject":"自立","classIds":["特支1","c1777991582711"],"_benchDay":"火","_benchDate":null,"teacherIds":["T45259"],"_benchPeriod":1},{"id":1778913443287,"day":"月","period":3,"subject":"社会","classIds":["特支1","c1777991582711"],"teacherIds":["T07"]},{"id":1778913602955,"day":"月","period":4,"subject":"道徳","classIds":["特支1","c1777991582711"],"teacherIds":["T45259"]},{"id":1778913759041,"day":"月","period":5,"subject":"数学","classIds":["特支1","c1777991582711"],"teacherIds":["T45259"]},{"id":1778913794960,"day":"火","period":1,"subject":"国語","classIds":["特支1"],"teacherIds":["T05"]},{"id":1778914029865,"day":"火","period":2,"subject":"英語","classIds":["特支1","c1777991582711"],"teacherIds":["T45259"]},{"id":1778916386743,"day":"火","note":"","period":3,"subject":"技術","classIds":["特支1","2-1"],"teacherIds":["T49453"]},{"id":1778916422256,"day":"火","period":5,"subject":"理科","classIds":["特支1","c1777991582711"],"teacherIds":["T45259"]},{"id":1778917124148,"day":"火","period":4,"subject":"体育","classIds":["2-1","特支1","c1777991594895"],"teacherIds":["T41783"]},{"id":1778917439212,"day":"火","period":6,"subject":"特別活動","classIds":["特支1","c1777991582711"],"teacherIds":["T45259"]},{"id":1778917458427,"day":"水","period":1,"subject":"英語","classIds":["特支1","c1777991582711"],"teacherIds":["T45259"]},{"id":1778917544559,"day":"水","period":6,"subject":"数学","classIds":["特支1","c1777991582711"],"teacherIds":["T45259"]},{"id":1778917555792,"day":"木","period":1,"subject":"理科","classIds":["特支1","c1777991582711"],"teacherIds":["T45259"]},{"id":1778917577342,"day":"木","note":"","period":3,"subject":"英語","classIds":["特支1","c1777991582711"],"teacherIds":["T45259","T51994"]},{"id":1778917627345,"day":"木","period":6,"subject":"国語","classIds":["特支1","c1777991582711"],"teacherIds":["T07"]},{"id":1778917635140,"day":"金","period":1,"subject":"数学","classIds":["特支1","c1777991582711"],"teacherIds":["T45259"]},{"id":1778917638472,"day":"金","period":2,"subject":"作業","classIds":["特支1","c1777991582711"],"teacherIds":["T45259"]},{"id":1778917657277,"day":"金","period":4,"subject":"国語","classIds":["特支1","c1777991582711"],"teacherIds":["T07"]},{"id":1778917664437,"day":"金","period":5,"subject":"社会","classIds":["特支1","c1777991582711"],"teacherIds":["T07"]},{"id":1778917668148,"day":"金","period":6,"subject":"理科","classIds":["特支1","c1777991582711"],"teacherIds":["T45259"]},{"id":1778917697502,"day":"水","period":5,"subject":"社会","classIds":["特支1","c1777991582711"],"teacherIds":["T07"]},{"id":1778918591346,"day":"木","period":5,"subject":"社会","classIds":["c1777991582711"],"teacherIds":["T07"]},{"id":1778918779171,"day":"火","period":3,"subject":"数学","classIds":["c1777991582711"],"teacherIds":["T04"]},{"id":1778922973069,"day":"月","period":2,"subject":"社会","classIds":["c1777991594895","c1777991605023"],"teacherIds":["T05"]},{"id":1778923308813,"day":"火","period":6,"subject":"特別活動","classIds":["c1777991594895","c1777991605023"],"teacherIds":["T02"]},{"id":1779848649402,"day":"月","note":"","period":1,"subject":"自立","classIds":["c1778042181266"],"linkGroup":"lg-1779848688896","teacherIds":["T06"]},{"id":1779879350317,"day":"火","note":"","period":3,"subject":"自立","classIds":["c1778042181266"],"linkGroup":"lg-1779879346295","teacherIds":["T06"]},{"id":1779879378487,"day":"月","note":"","period":5,"subject":"自立","classIds":["c1778042184836"],"linkGroup":"lg-1779879377037","teacherIds":["T06"]},{"id":1779949921079,"day":"火","period":6,"subject":"自立","classIds":["c1779948886215"],"teacherIds":["T03"]},{"id":1779950009291,"day":"金","period":5,"subject":"自立","classIds":["c1779948886215"],"teacherIds":["T03"]},{"id":1779951731689,"day":"木","period":5,"subject":"理科","classIds":["c1777991605023"],"teacherIds":["T02"]},{"id":1779952214618,"day":"月","period":5,"subject":"自立","classIds":["c1779948886215"],"teacherIds":["T07"]},{"id":1779952435700,"day":"水","period":6,"subject":"自立","classIds":["c1779948886215"],"teacherIds":["T07"]},{"id":1779952507984,"day":"火","note":"","period":2,"subject":"自立","classIds":["c1778042189316"],"linkGroup":"lg-1779952521238","teacherIds":["T06"]},{"id":1779952571050,"day":"金","note":"","period":1,"subject":"自立","classIds":["c1778042260582"],"linkGroup":"lg-1779952715268","teacherIds":["T06"]},{"id":1779952702624,"day":"金","note":"","period":1,"subject":"英語","classIds":["2-2"],"teacherIds":["T64123","T51994"]},{"id":1779953842432,"day":"金","note":"","period":6,"subject":"自立","classIds":["c1778042184836"],"linkGroup":"lg-1779953908588","teacherIds":["T06"]},{"id":1779953901282,"day":"金","period":6,"subject":"国語","classIds":["2-1"],"linkGroup":"lg-1779953908588","teacherIds":["T02"]},{"id":1779953928992,"day":"火","note":"","period":2,"subject":"英語","classIds":["2-1"],"teacherIds":["T51994","T64123"]},{"id":1779954035272,"day":"水","period":5,"subject":"自立","classIds":["c1779948886215"],"teacherIds":["T64123"]},{"id":1779954107973,"day":"金","period":6,"subject":"自立","classIds":["c1779948886215"],"teacherIds":["T64123"]},{"id":1779954173715,"day":"木","period":1,"subject":"数学","classIds":["1-1"],"teacherIds":["T04"]},{"id":1779962308543,"day":"火","note":"","period":4,"altWeek":"B","subject":"理科","classIds":["2-2"],"teacherIds":["T05"]},{"id":1779969645146,"day":"木","note":"","period":5,"altWeek":"A","subject":"理科","classIds":["2-2"],"teacherIds":["T05"]},{"id":1779970652634,"day":"木","note":"","period":2,"altWeek":"B","subject":"音楽","classIds":["1-1"],"teacherIds":["T07"]},{"id":1779971948762,"day":"月","period":3,"subject":"理科","classIds":["2-2"],"teacherIds":["T05"]},{"id":1779972507482,"day":"金","note":"","period":3,"subject":"体育","classIds":["特支1","2-1","c1777991594895"],"teacherIds":["T41783"]},{"id":1779972967722,"day":"火","period":4,"subject":"理科","classIds":["c1777991605023"],"teacherIds":["T02"]},{"id":1779973054722,"day":"月","note":"","period":3,"subject":"理科","classIds":["c1777991605023","c1777991594895"],"teacherIds":["T02"]},{"id":1779973184018,"day":"火","period":5,"subject":"数学","classIds":["2-2"],"teacherIds":["T04"]}],"weeklyPlan":{"1-1":{"体育":3,"国語":4,"学活":1,"家庭":1,"技術":1,"数学":4,"理科":3,"社会":3,"総合":1,"美術":1,"英語":4,"道徳":1,"音楽":1},"1-2":{"体育":3,"国語":4,"学活":1,"家庭":1,"技術":1,"数学":4,"理科":3,"社会":3,"総合":1,"美術":1,"英語":4,"道徳":1,"音楽":1}},"schoolSlots":{"月":[1,2,3,4,5],"木":[1,2,3,4,5,6],"水":[1,2,3,4,5,6],"火":[1,2,3,4,5,6],"金":[1,2,3,4,5,6]},"meetings":[{"id":1778331795616,"day":"金","name":"2学年部会","type":"学年部会","period":2,"teacherIds":["T06","T07","T02"]},{"id":1778331845688,"day":"木","name":"1学年部会","type":"学年部会","period":6,"teacherIds":["T41783","T05","T03"]},{"id":1778331885984,"day":"金","name":"3学年部会","type":"学年部会","period":3,"teacherIds":["T64123","T04","T45259"]},{"id":1778331955696,"day":"火","name":"学年主任会議","type":"その他","period":5,"teacherIds":["T01","T05","T02","T64123"]},{"id":1778332006008,"day":"木","name":"校務運営委員会","type":"校務運営委員会","period":2,"teacherIds":["T01","T41783","T05","T02","T64123"]},{"id":1778407365629,"day":"月","name":"企画会議","type":"その他","period":2,"teacherIds":["T01","T41783"]},{"id":1779954522396,"day":"水","name":"初任者研修","type":"その他","period":3,"teacherIds":["T45259"]},{"id":1779954552130,"day":"水","name":"初任者研修","type":"その他","period":5,"teacherIds":["T45259"]}],"abWeekBase":"2026-04-06"};

const TH={padding:"6px 8px",border:"1px solid #CBD5E1",background:"#F1F5F9",fontWeight:700,textAlign:"center",fontSize:12,whiteSpace:"pre",color:"#334155"};
const PTH={...TH,background:"#1E3A5F",color:"white",minWidth:40,whiteSpace:"nowrap"};
const chip=(on,bg="#1E3A5F")=>({padding:"3px 11px",border:"1.5px solid",borderRadius:20,cursor:"pointer",fontSize:12,borderColor:on?bg:"#CBD5E1",background:on?bg:"white",color:on?"white":"#334155",fontWeight:on?700:400,transition:"all 0.12s"});

// ── エラー境界 ───────────────────────────────────────────────────────────────
export default function App({user,authDebug,onLogout,classParam,modeParam,isAdmin,usePublished=false,isDemo=false}){

  const[base,setBase]=useState(()=>isDemo?DEMO_DATA.base:genBase());
  const mon0=getMon(todayStr());
  const[changes,setChanges]=useState([]);
  const[teachers,setTeachers]=useState(isDemo?DEMO_DATA.teachers:INIT_T);
  const[schoolName,setSchoolName]=useState(isDemo?DEMO_DATA.schoolName:(SCHOOL_NAME||"〇〇中学校"));
  const[adminEmails,setAdminEmails]=useState([]);
  const[classes,setClasses]=useState(isDemo?DEMO_DATA.classes:INIT_CLASSES);
  const[subjects,setSubjects]=useState(isDemo?DEMO_DATA.subjects:INIT_SUBJ);
  const[weeklyPlan,setWeeklyPlan]=useState(isDemo?DEMO_DATA.weeklyPlan:INIT_WEEKLY);
  // 学校で使用する曜日×時限の設定（null=未設定: 基本=授業の使用実績から推定 / 週間=制限なし）
  const[schoolSlots,setSchoolSlots]=useState(isDemo?DEMO_DATA.schoolSlots:null); // 例 {月:[1,2,3,4,5],...}
  const[abWeekBase,setAbWeekBase]=useState(isDemo?DEMO_DATA.abWeekBase:""); // A週の基準月曜日
  const cn=id=>classes.find(c=>c.id===id)?.name||id;
  const[view,setView]=useState("class");
  const[dateMode,setDateMode]=useState(false);
  const[wkStart,setWkStart]=useState(mon0);
  const[selCls,setSelCls]=useState("1-1");
  const[selTch,setSelTch]=useState("T01");
  const[selDi,setSelDi]=useState(0);
  const[modal,setModal]=useState(null);
  const[setupOpen,setSetupOpen]=useState(false);
  const[hov,setHov]=useState(null);
  const[blockPicker,setBlockPicker]=useState(null);
  const[dragVisual,setDragVisual]=useState(null);
  const[hoverHk,setHoverHk]=useState(null);
  const[conflictPulseHks,setConflictPulseHks]=useState(new Set()); // パルス表示する重複相手hk
  // トライアルパネルで候補ホバー時に移動先セルを点滅させるターゲット {date,day,period,tids:[],cids:[]}
  const[candidateTargetPulse,setCandidateTargetPulse]=useState(null);
  // candidateTargetPulse に応じて該当セル(td)へ candidate-target-pulse クラスを直接付与
  // （MultiCell/CellTD はインライン定義で再マウントするため、render後にDOMで確実に当てる）
  useEffect(()=>{
    const CLASSES=["candidate-target-pulse","candidate-from-pulse","candidate-both-pulse"];
    // 点滅セルが横スクロールで隠れているとき、その列が見える位置まで横方向だけスクロールする。
    // （縦はいじらないのでページが飛ばない。教員列が画面外でも点滅が必ず見えるように）
    const scrollColIntoView=(el)=>{
      if(!el)return;
      let sc=el.parentElement;
      while(sc){
        const st=getComputedStyle(sc);
        if((st.overflowX==='auto'||st.overflowX==='scroll')&&sc.scrollWidth>sc.clientWidth+2)break;
        sc=sc.parentElement;
      }
      if(!sc)return;
      const er=el.getBoundingClientRect(),sr=sc.getBoundingClientRect(),margin=24;
      if(er.left<sr.left+margin)sc.scrollLeft-=(sr.left+margin-er.left);
      else if(er.right>sr.right-margin)sc.scrollLeft+=(er.right-(sr.right-margin));
    };
    const apply=()=>{
      CLASSES.forEach(cls=>document.querySelectorAll("."+cls).forEach(el=>el.classList.remove(cls)));
      const cp=candidateTargetPulse;
      if(!cp)return;
      // セル(td)が指定スロット(period/date|day)＋識別(tid/cid)に一致するか
      const tdMatches=(td,spec)=>{
        if(Number(td.getAttribute("data-sp"))!==spec.period)return false;
        const sd=td.getAttribute("data-sd")||"";
        const sday=td.getAttribute("data-sday")||"";
        const whenOk=dateModeRef.current?(sd===spec.date):(sday===spec.day);
        if(!whenOk)return false;
        const stid=td.getAttribute("data-stid")||"";
        const scid=td.getAttribute("data-scid")||"";
        return (stid&&(spec.tids||[]).includes(stid))||(scid&&(spec.cids||[]).includes(scid));
      };
      // 複数セル指定（連鎖の全駒ハイライト）: kind=from/to を集計し、両方該当するセルは both(青)
      if(cp.cells){
        document.querySelectorAll("td[data-sp]").forEach(td=>{
          let hasFrom=false,hasTo=false;
          cp.cells.forEach(spec=>{
            if(tdMatches(td,spec)){ if(spec.kind==='from')hasFrom=true; else hasTo=true; }
          });
          if(hasFrom&&hasTo)td.classList.add("candidate-both-pulse");
          else if(hasTo)td.classList.add("candidate-target-pulse");
          else if(hasFrom)td.classList.add("candidate-from-pulse");
        });
        // 到着(緑/青)を優先して、なければ出発(アンバー)を、見える位置へ寄せる
        scrollColIntoView(document.querySelector("td.candidate-target-pulse,td.candidate-both-pulse")||document.querySelector("td.candidate-from-pulse"));
        return;
      }
      // 単一スロット指定（直接候補ホバー: 従来通り緑）
      document.querySelectorAll("td[data-sp]").forEach(td=>{
        if(tdMatches(td,cp))td.classList.add("candidate-target-pulse");
      });
      scrollColIntoView(document.querySelector("td.candidate-target-pulse"));
    };
    apply();
    // 再マウント後も確実に当てるため次フレームでもう一度
    const raf=requestAnimationFrame(apply);
    return()=>cancelAnimationFrame(raf);
  },[candidateTargetPulse]);
  // 【v8_7_24】ホバー用ハイライトを「状態更新なし」で対象セルに直接当てる。
  //   セルはインライン定義で再描画のたび作り直されるため、状態更新すると作り直し→onMouseLeave誤発火で
  //   点滅が不安定になる。状態を触らずDOMへ直接クラスを付け外しすることで、乗せている間は安定して点滅し、
  //   外した瞬間に確実に消える。spec=null で消去。（空きジャンプ・交換パネルは従来のcandidateTargetPulseのまま）
  const flashHoverCells=(spec)=>{
    document.querySelectorAll("td.hover-target-pulse").forEach(el=>el.classList.remove("hover-target-pulse"));
    if(!spec)return;
    let firstEl=null;
    document.querySelectorAll("td[data-sp]").forEach(td=>{
      if(Number(td.getAttribute("data-sp"))!==spec.period)return;
      const sd=td.getAttribute("data-sd")||"",sday=td.getAttribute("data-sday")||"";
      const whenOk=dateModeRef.current?(sd===spec.date):(sday===spec.day);
      if(!whenOk)return;
      const stid=td.getAttribute("data-stid")||"",scid=td.getAttribute("data-scid")||"";
      if((stid&&(spec.tids||[]).includes(stid))||(scid&&(spec.cids||[]).includes(scid))){
        td.classList.add("hover-target-pulse");
        if(!firstEl)firstEl=td;
      }
    });
    if(firstEl){
      let sc=firstEl.parentElement;
      while(sc){const st=getComputedStyle(sc);if((st.overflowX==="auto"||st.overflowX==="scroll")&&sc.scrollWidth>sc.clientWidth+2)break;sc=sc.parentElement;}
      if(sc){const er=firstEl.getBoundingClientRect(),sr=sc.getBoundingClientRect(),m=24;
        if(er.left<sr.left+m)sc.scrollLeft-=(sr.left+m-er.left);
        else if(er.right>sr.right-m)sc.scrollLeft+=(er.right-(sr.right-m));}
    }
  };
  // 【v8_7_27】ホバー点滅を完全ポインタ駆動に。
  //   mouseenter/leave はセルの作り直しと重なると取りこぼす（発火しない）ことがあるため一切使わない。
  //   説明行・補欠先生名に data-hoverspec(JSON) を埋め込み、マウス移動のたびに
  //   「指定の上にいれば点ける／いなければ消す」を判定する。毎レンダー後の当て直しも維持。
  const hoverFlashRef=useRef(null); // {raw, spec}
  useEffect(()=>{
    const hf=hoverFlashRef.current;
    if(hf)flashHoverCells(hf.spec);
  }); // 依存なし：毎レンダー後に当て直し（作り直し対策）
  useEffect(()=>{
    const onMove=(e)=>{
      const t=e.target;
      const el=t&&t.closest?t.closest("[data-hoverspec]"):null;
      if(el){
        const raw=el.getAttribute("data-hoverspec");
        if(!hoverFlashRef.current||hoverFlashRef.current.raw!==raw){
          try{const spec=JSON.parse(raw);hoverFlashRef.current={raw,spec};flashHoverCells(spec);}
          catch(_){/* 属性が壊れていたら何もしない */}
        }
      }else if(hoverFlashRef.current){
        hoverFlashRef.current=null;flashHoverCells(null);
      }
    };
    document.addEventListener("pointermove",onMove,true);
    return()=>document.removeEventListener("pointermove",onMove,true);
  },[]);
  // 【v8_7_29】学級・授業者・曜日タブの切り替えを「0.1秒以上その場に留まったときだけ」に。
  //   これまでは onMouseEnter で即切り替わり、指やマウスで通り過ぎただけでも誤って切り替わっていた。
  //   乗った瞬間にタイマーを仕掛け、100ms後もまだ同じ要素に乗っていれば実行。先に離れれば取り消す。
  const hoverSwitchTimerRef=useRef(null);
  const hoverSwitchElRef=useRef(null);
  const hoverSwitch=(fn,el)=>{
    if(hoverSwitchTimerRef.current)clearTimeout(hoverSwitchTimerRef.current);
    hoverSwitchElRef.current=el;
    hoverSwitchTimerRef.current=setTimeout(()=>{
      if(hoverSwitchElRef.current===el)fn();
    },100);
  };
  const hoverSwitchCancel=()=>{
    if(hoverSwitchTimerRef.current)clearTimeout(hoverSwitchTimerRef.current);
    hoverSwitchElRef.current=null;
  };
  const trialHiRef=useRef(null); // {src, tgt, conflicts:[]} 各 {period,date,day,tids,cids}
  useEffect(()=>{
    const T="trial-target-cell",C="trial-conflict-cell",S="trial-source-cell";
    const apply=()=>{
      document.querySelectorAll("."+T).forEach(el=>el.classList.remove(T));
      document.querySelectorAll("."+C).forEach(el=>el.classList.remove(C));
      document.querySelectorAll("."+S).forEach(el=>el.classList.remove(S));
      const hi=trialHiRef.current;
      if(!hi)return;
      const matchSlot=(td,s)=>{
        if(!s)return false;
        if(Number(td.getAttribute("data-sp"))!==s.period)return false;
        const whenOk=dateModeRef.current?((td.getAttribute("data-sd")||"")===s.date):((td.getAttribute("data-sday")||"")===s.day);
        if(!whenOk)return false;
        const stid=td.getAttribute("data-stid")||"",scid=td.getAttribute("data-scid")||"";
        return(stid&&(s.tids||[]).includes(stid))||(scid&&(s.cids||[]).includes(scid));
      };
      document.querySelectorAll("td[data-sp]").forEach(td=>{
        // 優先度: 重複相手(オレンジ) > 移動先(青) > 移動元(グレー)
        if((hi.conflicts||[]).some(s=>matchSlot(td,s))){td.classList.add(C);return;}
        if(matchSlot(td,hi.tgt)){td.classList.add(T);return;}
        if(matchSlot(td,hi.src))td.classList.add(S);
      });
    };
    apply();
    const raf=requestAnimationFrame(apply);
    return()=>cancelAnimationFrame(raf);
  });
  const[bench,setBench]=useState(Array(8).fill(null));
  const[unplacedFilterCid,setUnplacedFilterCid]=useState("all");
  const[studentMode,setStudentMode]=useState(false);
  const[teacherMode,setTeacherMode]=useState(false);
  const[zoom,setZoom]=useState(1);
  const[isFullscreen,setIsFullscreen]=useState(false);
  // ── ② 追加：バックアップモーダル state ──────────────────────────────────────
  const[backupModal,setBackupModal]=useState(false);
  // 🔍 データ整合性チェック モーダル state
  const[integrityModal,setIntegrityModal]=useState(null);
  // 📊 集計モーダル
  const[statsModal,setStatsModal]=useState(false);
  const[adminMgrOpen,setAdminMgrOpen]=useState(false);
  // 🔗 連動移動の通知
  const[linkNotice,setLinkNotice]=useState(null);
  // ── 移動サマリー通知（玉突き・重複解消など複数コマの移動内容を表示）──
  const[moveNotice,setMoveNotice]=useState(null); // {title, lines:[]}
  const moveNoticeTimerRef=useRef(null);
  const showMoveNotice=(title,lines)=>{
    setMoveNotice({title,lines});
    clearTimeout(moveNoticeTimerRef.current);
    moveNoticeTimerRef.current=setTimeout(()=>setMoveNotice(null),10000);
  };
  // 🔗 連動移動調整モーダル
  const[linkAdjustModal,setLinkAdjustModal]=useState(null); // {text, timeout}
  // ④ 最後に操作したセルのhk
  const[lastEdited,setLastEdited]=useState(null);
  // ④-2 直近に「動いた駒」のID集合（idベース／スワップ・3コマ回転の全駒を強調）
  const[movedIds,setMovedIds]=useState(()=>new Set());
  // ④-3 直近に「動きがあったセル」のhk集合（位置ベース／移動元の空セルも強調可）
  const[movedHks,setMovedHks]=useState(()=>new Set());
  // 授業者一覧ビューの先生列ドラッグ並び替え用
  const[teacherDragIdx,setTeacherDragIdx]=useState(null);
  // ① 曜日パターン（日替え時程）: [{date:"2025-05-12", useDay:"火"}]
  const[dayPatterns,setDayPatterns]=useState([]);
  // ① 時限レベルのパターンピッカー
  const[periodPatternPicker,setPeriodPatternPicker]=useState(null);

  // ── パターン解決ヘルパー ──────────────────────────────────────────────────
  const getPatDay=(date,p)=>{
    const pat=dayPatterns.find(dp=>dp.date===date);
    return pat?.periods?.[String(p)]?.day||pat?.useDay||dowOf(date);
  };
  const getPatPeriod=(date,p)=>{
    const pat=dayPatterns.find(dp=>dp.date===date);
    const pp=pat?.periods?.[String(p)]?.period;
    return pp!=null?pp:p;
  };
  const setDayPat=(date,useDay)=>{
    setDayPatterns(prev=>{
      const others=prev.filter(p=>p.date!==date);
      if(!useDay||useDay===dowOf(date)){return others;}
      const existing=prev.find(p=>p.date===date)||{};
      return[...others,{...existing,date,useDay}];
    });
  };
  const setPeriodPat=(date,period,day,patPeriod)=>{
    setDayPatterns(prev=>{
      const existing=prev.find(p=>p.date===date)||{date,useDay:dowOf(date)||'月'};
      const newPeriods={...(existing.periods||{})};
      const defDay=existing.useDay||dowOf(date);
      if(day===defDay&&patPeriod===period){
        delete newPeriods[String(period)];
      }else{
        newPeriods[String(period)]={day,period:patPeriod};
      }
      const others=prev.filter(p=>p.date!==date);
      const noCustom=Object.keys(newPeriods).length===0;
      const isDefault=!existing.useDay||existing.useDay===dowOf(date);
      if(noCustom&&isDefault)return others;
      return[...others,{...existing,periods:newPeriods}];
    });
  };
  const clearPeriodPat=(date,period)=>{
    setDayPatterns(prev=>{
      const existing=prev.find(p=>p.date===date);
      if(!existing)return prev;
      const newPeriods={...(existing.periods||{})};
      delete newPeriods[String(period)];
      const others=prev.filter(p=>p.date!==date);
      const noCustom=Object.keys(newPeriods).length===0;
      const isDefault=!existing.useDay||existing.useDay===dowOf(date);
      if(noCustom&&isDefault)return others;
      return[...others,{...existing,periods:newPeriods}];
    });
  };
  const[dayPatternPicker,setDayPatternPicker]=useState(null); // date or null

  const[urlModal,setUrlModal]=useState(false);
  const[hasUnpublished,setHasUnpublished]=useState(false); // 未確定の変更あり
  const[publishing,setPublishing]=useState(false);
  const[publishedAt,setPublishedAt]=useState(null); // 最終確定日時

  // ── 非常勤の特定日出勤オーバーライド ──────────────────────────────────────
  // [{teacherId, date}] の配列。通常不在でもこの日は出勤扱い
  const[teacherDateOverrides,setTeacherDateOverrides]=useState([]);

  // ── ② 一括休日・欠課設定 ──────────────────────────────────────────────────
  const[batchModal,setBatchModal]=useState(false); // false | "input" | "pattern" | "history" // false | "input" | "pattern" | "history"

  // ── 祝日一括登録 ──────────────────────────────────────────────────────────
  const[holidayModal,setHolidayModal]=useState(false);

  // ── 診断用エラーキャッチャー（本番で白画面になる原因を特定するため） ──────
  useEffect(()=>{
    const h=(e)=>{
      const msg=`エラー: ${e.message}\n場所: ${e.filename}:${e.lineno}\nスタック: ${e.error?.stack?.slice(0,300)||""}`;
      document.title="ERROR: "+e.message.slice(0,50);
      const div=document.createElement('div');
      div.style.cssText='position:fixed;top:0;left:0;right:0;padding:16px;background:#7F1D1D;color:white;font:12px monospace;z-index:99999;white-space:pre-wrap;max-height:50vh;overflow:auto;';
      div.textContent=msg;
      div.onclick=()=>div.remove();
      document.body.appendChild(div);
    };
    window.addEventListener('error',h);
    return()=>window.removeEventListener('error',h);
  },[]);
  // meeting = {id, name, type, day, period, teacherIds}
  const[meetings,setMeetings]=useState(isDemo?DEMO_DATA.meetings:[]);
  const[meetingModal,setMeetingModal]=useState(false);

  // ── 重複解消モーダル ─────────────────────────────────────────────────────
  const[conflictResolveModal,setConflictResolveModal]=useState(null);
  const[panelMinimized,setPanelMinimized]=useState(false);
  // ── 学級空き通知 ──────────────────────────────────────────────────────────
  const[emptyClassNotice,setEmptyClassNotice]=useState(null); // {classId,period,date}

  // ── 3コマ回転候補ダイアログ ───────────────────────────────────────────────
  const[chainModal,setChainModal]=useState(null);
  // ── 玉突き提案ダイアログ（移動元の空き枠を同一クラス内のずらしで埋める）──
  const[fillHoleModal,setFillHoleModal]=useState(null);
  // ── ドラッグ中の3コマ候補ハイライト ──────────────────────────────────────
  const chainCandidatesRef=useRef([]);
  const[chainVersion,setChainVersion]=useState(0);
  const chainTimerRef=useRef(null);

  // ── 週末表示モード ────────────────────────────────────────────────────────
  const[showWeekend,setShowWeekend]=useState(false);

  // ── ⑤ 基本時間割期間切り替え ─────────────────────────────────────────────
  // periodDefs: [{id, name, startDate, endDate}]
  // activePeriodId: 現在編集中の期間ID
  // savedPeriodBases: {[periodId]: [...entries]} — 非アクティブ期間のbase保存先
  // savedPeriodTeacherAsgns: {[periodId]: {[teacherId]: asgn[]}} — 期間ごとの持ち時間
  const[periodDefs,setPeriodDefs]=useState([{id:"default",name:"通常時間割",startDate:null,endDate:null}]);
  const[activePeriodId,setActivePeriodId]=useState("default");
  const[savedPeriodBases,setSavedPeriodBases]=useState({});
  const[savedPeriodTeacherAsgns,setSavedPeriodTeacherAsgns]=useState({});

  useEffect(()=>{
    const onFs=()=>setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange',onFs);
    return()=>document.removeEventListener('fullscreenchange',onFs);
  },[]);
  const[dbLoaded,setDbLoaded]=useState(false);
  const[saving,setSaving]=useState(false);

  const historyRef=useRef([]);
  const redoRef=useRef([]);
  const currentRef=useRef({base,changes,dayPatterns});
  currentRef.current={base,changes,dayPatterns};
  // トライアルパネル（衝突解消）開始前の状態スナップショット。やり直し/キャンセルで確実に復元する用。
  const trialSnapRef=useRef(null);
  const mainPlacedRef=useRef(false); // 重複解消パネルで主役を配置済みか

  const saveRef=useRef({});
  saveRef.current={base,changes,teachers,schoolName,adminEmails,classes,subjects,weeklyPlan,schoolSlots,dayPatterns,periodDefs,activePeriodId,savedPeriodBases,savedPeriodTeacherAsgns,meetings,teacherDateOverrides,abWeekBase};


  useEffect(()=>{
    if(isDemo){setDbLoaded(true);return;} // 体験版: DB読み込みせずコード内のサンプルデータを使用
    (async()=>{
      try{
        const endpoint=usePublished
          ?'/rest/v1/timetable_published?id=eq.main'
          :'/rest/v1/timetable_data?id=eq.main';
        const res=await sbFetch(endpoint);
        const rows=await res.json();
        const d=rows[0]?.data||{};
        if(usePublished&&rows[0]?.published_at) setPublishedAt(rows[0].published_at);
        if(d.base?.length)      setBase(d.base);
        if(d.changes?.length)   setChanges(d.changes);
        if(d.teachers?.length)  setTeachers(d.teachers);
        if(d.schoolName)        setSchoolName(d.schoolName);
        if(d.classes?.length)   setClasses(d.classes);
        if(d.subjects?.length)  setSubjects(d.subjects);
        if(d.weeklyPlan)        setWeeklyPlan(d.weeklyPlan);
        if(d.schoolSlots)       setSchoolSlots(d.schoolSlots);
        if(d.abWeekBase)       setAbWeekBase(d.abWeekBase);
        if(d.adminEmails)      setAdminEmails(d.adminEmails);
        if(d.dayPatterns)       setDayPatterns(d.dayPatterns);
        if(d.periodDefs?.length) setPeriodDefs(d.periodDefs);
        if(d.activePeriodId)    setActivePeriodId(d.activePeriodId);
        if(d.savedPeriodBases)  setSavedPeriodBases(d.savedPeriodBases);
        if(d.savedPeriodTeacherAsgns) setSavedPeriodTeacherAsgns(d.savedPeriodTeacherAsgns);
        if(d.meetings?.length)  setMeetings(d.meetings);
        if(d.teacherDateOverrides?.length) setTeacherDateOverrides(d.teacherDateOverrides);
      }catch(e){console.error('Supabase load error',e);}
      setDbLoaded(true);
    })();
  },[]);

  useEffect(()=>{
    if(!dbLoaded)return;
    setSaving(true);
    const t=setTimeout(async()=>{
      try{
        await sbFetch('/rest/v1/timetable_data?id=eq.main',{
          method:'PATCH',
          headers:{'Prefer':'return=minimal'},
          body:JSON.stringify({data:saveRef.current,updated_at:new Date().toISOString()}),
        });
      }catch(e){console.error('Supabase save error',e);}
      setSaving(false);
    },1000);
    return()=>clearTimeout(t);
  },[base,changes,teachers,schoolName,adminEmails,classes,subjects,weeklyPlan,schoolSlots,dayPatterns,periodDefs,activePeriodId,savedPeriodBases,meetings,teacherDateOverrides,abWeekBase,dbLoaded]);

  // ── 定期自動バックアップ（15分ごと・変更があった時のみ）──────────────────
  const lastBackupDataRef=useRef(null);
  useEffect(()=>{
    if(!dbLoaded)return;
    const INTERVAL=15*60*1000; // 15分
    const timer=setInterval(async()=>{
      try{
        const current=JSON.stringify(saveRef.current);
        if(current===lastBackupDataRef.current)return; // 変更なしはスキップ
        const now=new Date();
        const label=`自動バックアップ ${now.getHours()}:${String(now.getMinutes()).padStart(2,'0')}`;
        await sbSaveBackup(saveRef.current,label);
        lastBackupDataRef.current=current; // バックアップ後に記録を更新
      }catch(e){console.error('auto backup error',e);}
    },INTERVAL);
    return()=>clearInterval(timer);
  },[dbLoaded]);

  const MAX_HISTORY=30;
  const [historyLen,setHistoryLen]=useState(0);
  // base/changes の変化を自動検出して履歴保存
  const prevBaseRef=useRef(base);
  const prevChangesRef=useRef(changes);
  const prevDayPatternsRef=useRef(dayPatterns);
  const skipHistoryRef=useRef(false); // switchPeriod等でskipする場合true
  useEffect(()=>{
    if(skipHistoryRef.current){
      prevBaseRef.current=base;
      prevChangesRef.current=changes;
      prevDayPatternsRef.current=dayPatterns;
      skipHistoryRef.current=false;
      return;
    }
    if(base===prevBaseRef.current&&changes===prevChangesRef.current&&dayPatterns===prevDayPatternsRef.current)return;
    const snapshot={base:prevBaseRef.current,changes:prevChangesRef.current,dayPatterns:prevDayPatternsRef.current};
    historyRef.current=[...historyRef.current.slice(-MAX_HISTORY+1),snapshot];
    redoRef.current=[];
    setHistoryLen(historyRef.current.length);
    setHasUnpublished(true); // 変更あり → 未確定
    prevBaseRef.current=base;
    prevChangesRef.current=changes;
    prevDayPatternsRef.current=dayPatterns;
  },[base,changes,dayPatterns]);
  const saveHistory=()=>{}; // useEffect自動保存に統一（後方互換のため残す）
  const setBaseH=fn=>setBase(fn);
  const setChangesH=fn=>setChanges(fn);

  // ── 確定・公開 ────────────────────────────────────────────────────────────
  const publish=async()=>{
    setPublishing(true);
    try{
      // upsert: まずPATCH、行がなければPOST
      const patchRes=await sbFetch('/rest/v1/timetable_published?id=eq.main',{
        method:'PATCH',
        headers:{'Prefer':'return=minimal','Content-Type':'application/json'},
        body:JSON.stringify({data:saveRef.current,published_at:new Date().toISOString()}),
      });
      // Supabase PATCHは行がない場合204を返すが0件更新
      // Content-Rangeヘッダーで件数確認
      const range=patchRes.headers.get('Content-Range')||'';
      if(range==='*/*'||range.startsWith('0/')){
        // 行が存在しないのでINSERT
        await sbFetch('/rest/v1/timetable_published',{
          method:'POST',
          headers:{'Prefer':'return=minimal','Content-Type':'application/json'},
          body:JSON.stringify({id:'main',data:saveRef.current,published_at:new Date().toISOString()}),
        });
      }
      setHasUnpublished(false);
      setPublishedAt(new Date().toISOString());
      alert('✅ 確定・公開しました。生徒・教員ビューに反映されました。');
    }catch(e){
      alert('公開に失敗しました。');
    }
    setPublishing(false);
  };

  // 未確定のまま閉じようとしたら警告
  useEffect(()=>{
    const handler=e=>{
      if(!hasUnpublished)return;
      e.preventDefault();
      e.returnValue='確定していない変更があります。このまま閉じますか？';
      return e.returnValue;
    };
    window.addEventListener('beforeunload',handler);
    return()=>window.removeEventListener('beforeunload',handler);
  },[hasUnpublished]);

  // 週間変更モードで週をまたぐとき、表示中の週に対応する期間を自動切換え
  useEffect(()=>{
    if(!dateMode)return;
    if(periodDefs.length<=1)return;
    // startDate/endDate が設定された期間の中から wkStart が範囲内のものを探す
    const matched=periodDefs.find(p=>
      p.startDate&&p.endDate&&
      wkStart>=p.startDate&&wkStart<=p.endDate
    );
    // 見つからなければ startDate/endDate が null のデフォルト期間にフォールバック
    const targetId=matched?.id||(periodDefs.find(p=>!p.startDate&&!p.endDate)?.id)||periodDefs[0].id;
    if(targetId!==activePeriodId){
      switchPeriod(targetId,{clearHistory:false});
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[wkStart,dateMode]);

  const dragRef=useRef(null);
  const cellDataRef=useRef({});
  const hoverHkRef=useRef(null);
  const moveExecRef=useRef(null);
  // 週間モードの玉突き・重複解消を「全駒の最終位置を一度に確定する」原子的適用で行う関数。
  // 1コマずつの moveExec は、同じ学級・先生の駒が回転すると _removed マーカーが互いを
  // 消し合い土台が復活する不具合があるため、最終状態をまとめて構築する。
  const applyPlanAtomicRef=useRef(null);
  // teachers/classes を ref経由で常に最新を取得（useEffect[]内のonUpクロージャ対策）
  const teachersRef=useRef([]);
  teachersRef.current=teachers;
  const dateModeRef=useRef(false);
  dateModeRef.current=dateMode;
  const classesRef=useRef([]);
  classesRef.current=classes;
  const benchRef=useRef([]);
  benchRef.current=bench;
  const setSelClsRef=useRef(null);

  const activeDays=dateMode&&showWeekend?DAYS7:DAYS;
  const dates=useMemo(()=>dateMode&&showWeekend?wkDates7(wkStart):wkDates(wkStart),[dateMode,showWeekend,wkStart]);
  const datesRef=useRef(dates); datesRef.current=dates;

  const tn=id=>teachers.find(t=>t.id===id)?.name||"";

  // A/B週フィルタ：entryのaltWeekが今週のA/Bと一致するか（未設定=毎週表示）
  const abWeekNow=dateMode?getABWeek(wkStart,abWeekBase):null;
  const abWeekNowRef=useRef(null);
  abWeekNowRef.current=abWeekNow;
  const isABVisible=(entry)=>{
    if(!entry?.altWeek)return true; // 毎週
    if(!abWeekNow)return true; // 基準週未設定→全表示
    return entry.altWeek===abWeekNow;
  };
  const gE=(dayOrDate,p,cid,isDt=false)=>{
    if(isDt){
      const patDay=getPatDay(dayOrDate,p);
      const patPer=getPatPeriod(dayOrDate,p);
      const isCustomPat=patDay!==dowOf(dayOrDate)||patPer!==p;
      // カスタム時限パターンが設定されている場合はisBlockedより優先して表示
      if(isCustomPat){
        const entry=base.find(e=>e.day===patDay&&e.period===patPer&&e.classIds.includes(cid)&&isABVisible(e))||null;
        if(entry) return{...entry,_pat:true,_patDay:patDay,_patPeriod:patPer};
      }
      // 同一(date,period,class)に lesson と _removed が共存しうるため
      // lesson を優先（push順に依存しない2パス方式）
      const chgs=changes.filter(c=>c.date===dayOrDate&&c.period===p&&c.classIds.includes(cid));
      const lesson=chgs.find(c=>!c._removed);
      if(lesson) return{...lesson,day:dowOf(dayOrDate),_ch:true};
      if(chgs.length>0) return null; // _removed のみ → 削除マーカー
      if(!patDay)return null;
      const entry=base.find(e=>e.day===patDay&&e.period===patPer&&e.classIds.includes(cid)&&isABVisible(e))||null;
      if(isCustomPat&&entry)return{...entry,_pat:true,_patDay:patDay,_patPeriod:patPer};
      return entry;
    }
    // 基本時間割ビューではaltWeekを無視（最初の1件を返す）
    return base.find(e=>e.day===dayOrDate&&e.period===p&&e.classIds.includes(cid))||null;
  };

  // 学級別ビュー用: 同じセルに行事+出張など複数isBlockedが重なる場合を全て返す
  const gEsForCls=(date,p,cid)=>{
    const chgs=changes.filter(c=>c.date===date&&c.period===p&&c.classIds.includes(cid));

    // カスタム時限パターンが設定されている場合は isBlocked より優先して表示
    const patDay=getPatDay(date,p);
    const patPer=getPatPeriod(date,p);
    const isCustom=patDay!==dowOf(date)||patPer!==p;
    if(isCustom){
      const entry=base.find(e=>e.day===patDay&&e.period===patPer&&e.classIds.includes(cid)&&isABVisible(e))||null;
      if(entry) return[{...entry,_pat:true,_patDay:patDay,_patPeriod:patPer}];
    }

    const blocked=chgs.filter(c=>c.isBlocked);
    if(blocked.length>0){
      // noteでユニーク化（クラスごとに1エントリ作られるため重複除去）
      const unique=[...new Map(blocked.map(b=>[b.note||"空き",b])).values()];
      // 複数の異なるnote（行事+出張など）→ 全件返す
      if(unique.length>1) return unique.map(b=>({...b,day:dowOf(date),_ch:true}));
      // 1種類のみ → 通常通り1件返す
      return[{...unique[0],day:dowOf(date),_ch:true}];
    }
    const lesson=chgs.find(c=>!c._removed);
    if(lesson) return[{...lesson,day:dowOf(date),_ch:true}];
    if(chgs.length>0) return[null]; // _removedのみ
    if(!patDay)return[null];
    // A/B週フィルタを適用
    const entry=base.find(e=>e.day===patDay&&e.period===patPer&&e.classIds.includes(cid)&&isABVisible(e))||null;
    if(isCustom&&entry)return[{...entry,_pat:true,_patDay:patDay,_patPeriod:patPer}];
    return[entry];
  };

  const gEs=(dayOrDate,p,tid,isDt=false)=>{
    if(isDt){
      const actualDow=dowOf(dayOrDate);if(!actualDow)return[];
      const patDay=getPatDay(dayOrDate,p);
      const patPer=getPatPeriod(dayOrDate,p);
      const isCustom=patDay!==actualDow||patPer!==p;
      // この先生の変更エントリ
      const chgE=changes.filter(c=>c.date===dayOrDate&&c.period===p&&(c.teacherIds||[]).includes(tid)&&!c._removed);
      // 自分の変更エントリのclassIds（baseの重複表示を防ぐ）
      const myChgCids=new Set(chgE.flatMap(c=>c.classIds||[]));
      // _removedマーカーは「特定の先生のbaseを隠す」もの。teacherIdsを持っていれば自分宛のものだけ適用
      // （古いデータで teacherIds=[] のものは互換のため全先生に適用）
      const myRemovedCids=new Set(changes.filter(c=>{
        if(c.date!==dayOrDate||c.period!==p||!c._removed)return false;
        const tIds=c.teacherIds||[];
        return tIds.length===0||tIds.includes(tid);
      }).flatMap(c=>c.classIds||[]));
      const teacherClassIds=new Set(base.filter(e=>e.day===patDay&&e.period===patPer&&(e.teacherIds||[]).includes(tid)).flatMap(e=>e.classIds||[]));
      // カスタム時限パターンがある場合はisBlockedを除外（パターンの授業を優先表示）
      const blockedE=isCustom?[]:changes.filter(c=>c.date===dayOrDate&&c.period===p&&c.isBlocked&&(c.teacherIds||[]).length===0&&(c.classIds||[]).some(cid=>teacherClassIds.has(cid)));
      const allChg=[...chgE,...blockedE.filter(b=>!chgE.find(c=>c.id===b.id))];
      // isBlocked（出張）と同クラスのbaseも隠す
      const myBlockedCids=new Set(blockedE.flatMap(c=>c.classIds||[]));
      // 自分のbaseは「自分宛 _removed」または「自分のlesson change と同クラス」の場合のみ隠す
      // 他の先生が同じクラスに来ても自分のbaseは表示（衝突として両方表示・conflict検出に任せる）
      const baseE=base.filter(e=>
        e.day===patDay&&e.period===patPer&&
        (e.teacherIds||[]).includes(tid)&&
        !(e.classIds||[]).some(x=>myChgCids.has(x)||myBlockedCids.has(x))&&
        !(e.classIds||[]).some(x=>myRemovedCids.has(x))
      );
      return[...allChg.map(e=>({...e,_ch:true})),...baseE.map(e=>({...e,_ch:false,...(isCustom?{_pat:true,_patDay:patDay,_patPeriod:patPer}:{})}))];
    }
    return base.filter(e=>e.day===dayOrDate&&e.period===p&&e.teacherIds.includes(tid));
  };

  const conflicts=useMemo(()=>{
    try{
    const seen={};
    const map=new Map();
    const addConflict=(id,tid,withEntry)=>{
      const cur=map.get(id)||[];
      if(!cur.find(c=>c.tid===tid&&c.withEntry.id===withEntry.id))
        map.set(id,[...cur,{tid,withEntry}]);
    };
    const all=dateMode
      ?dates.flatMap(dt=>{const d=dowOf(dt);if(!d)return[];
          const chgE=changes.filter(c=>c.date===dt);
          // baseを除外するのは、その枠のbaseが「実質的に置き換えられた」場合だけ。
          // ＝ 同じ時限・同じクラスに次のいずれかのchangesがあるとき:
          //   ・_removed: 移動元として打ち消された
          //   ・isSubst : 補欠（駒は動かさず担当だけ変更 → baseを置き換える）
          // 通常の（_removedでも補欠でもない）changesで別の授業が来ただけなら、baseは残して
          // 「同じクラス・同じ時限に2つ」を重複として検出させる（運用上、要解消のため）。
          const replacedCidsByPeriod=new Map();
          chgE.filter(c=>c._removed||c.isSubst).forEach(c=>{
            const s=replacedCidsByPeriod.get(c.period)||new Set();
            (c.classIds||[]).forEach(x=>s.add(x));
            replacedCidsByPeriod.set(c.period,s);
          });
          return[...chgE.filter(e=>!e._removed),...base.filter(e=>{
            if(e.day!==d)return false;
            const replacedCids=replacedCidsByPeriod.get(e.period);
            if(!replacedCids)return true;
            // 打ち消し or 補欠で置き換えられたクラスのbaseは除外
            return!e.classIds.some(x=>replacedCids.has(x));
          })].map(e=>({...e,_k:`${dt}|${e.period}`}));
        })
      :base.map(e=>({...e,_k:`${e.day}|${e.period}`}));
    all.filter(e=>!e.isBlocked&&!e._removed).forEach(e=>(e.teacherIds||[]).forEach(tid=>{
      const k=`${tid}|${e._k}`;
      if(seen[k]){
        // A週とB週は同時に表示されないので衝突しない
        const aW=e.altWeek,bW=seen[k].entry?.altWeek;
        if(aW&&bW&&aW!==bW){seen[k]={id:e.id,entry:e};return;}
        addConflict(seen[k].id,tid,e);
        addConflict(e.id,tid,seen[k]);
      }else seen[k]={id:e.id,entry:e};
    }));

    // 授業↔会議の重複検出
    all.filter(e=>!e.isBlocked&&!e._removed).forEach(e=>{
      const eDay=dateMode?dowOf(e._k.split("|")[0]):e.day;
      const ePer=e.period;
      meetings.forEach(m=>{
        if(m.day!==eDay||m.period!==ePer)return;
        (e.teacherIds||[]).forEach(tid=>{
          if(!(m.teacherIds||[]).includes(tid))return;
          const cur=map.get(e.id)||[];
          const dummyId=`mtg-${m.id}-${tid}`;
          if(!cur.find(c=>c.withEntry.id===dummyId)){
            map.set(e.id,[...cur,{tid,withEntry:{id:dummyId,_isMeeting:true,_meetingName:m.name,classIds:[],teacherIds:[tid],subject:`【会議】${m.name}`}}]);
          }
        });
      });
    });

    // 不在スロットに授業が入っている場合の重複検出
    all.filter(e=>!e.isBlocked&&!e._removed).forEach(e=>{
      const eDay=dateMode?dowOf(e._k.split("|")[0]):e.day;
      const eDate=dateMode?e._k.split("|")[0]:null;
      const ePer=e.period;
      (e.teacherIds||[]).forEach(tid=>{
        const teacher=teachers.find(t=>t.id===tid);
        if(!teacher)return;
        if(!isSlotAvailable(teacher,eDay,ePer,eDate,teacherDateOverrides)){
          const cur=map.get(e.id)||[];
          const dummyId=`absent-${tid}-${eDay}-${ePer}`;
          if(!cur.find(c=>c.withEntry.id===dummyId)){
            map.set(e.id,[...cur,{tid,withEntry:{id:dummyId,_isAbsent:true,classIds:[],teacherIds:[tid],subject:`【不在】${eDay}曜${ePer}限`}}]);
          }
        }
      });
    });

    // クラス衝突検出（同じクラスが同じスロットで複数の異なるentry に含まれる）
    // 合同/TT は単一エントリ内に複数teacherIds で表現されるため、別entry に分かれていれば衝突
    // 現在の teachers に存在しない先生IDのみのentry（幽霊データ）は除外
    // ベンチに入っているエントリも除外（base から削除されていないが画面上は空き）
    const benchIdSet=new Set(bench.filter(Boolean).map(b=>b.id));
    const slotMap=new Map();
    all.filter(e=>!e.isBlocked&&!e._removed&&!benchIdSet.has(e.id)).forEach(e=>{
      const hasValidT=(e.teacherIds||[]).some(t=>teachers.find(x=>x.id===t));
      if(!hasValidT)return;
      const arr=slotMap.get(e._k)||[];
      arr.push(e);
      slotMap.set(e._k,arr);
    });
    slotMap.forEach(entries=>{
      for(let i=0;i<entries.length;i++){
        for(let j=i+1;j<entries.length;j++){
          const a=entries[i],b=entries[j];
          // A週とB週は同時に出ないので衝突しない
          if(a.altWeek&&b.altWeek&&a.altWeek!==b.altWeek)continue;
          const sharedCids=(a.classIds||[]).filter(c=>(b.classIds||[]).includes(c));
          if(sharedCids.length>0){
            sharedCids.forEach(cid=>{
              const cura=map.get(a.id)||[];
              if(!cura.find(c=>c.withEntry.id===b.id&&c.cid===cid))
                map.set(a.id,[...cura,{cid,withEntry:b}]);
              const curb=map.get(b.id)||[];
              if(!curb.find(c=>c.withEntry.id===a.id&&c.cid===cid))
                map.set(b.id,[...curb,{cid,withEntry:a}]);
            });
          }
        }
      }
    });

    return map;
    }catch(err){console.error("conflicts useMemo error:",err);return new Map();}
  },[base,changes,dateMode,dates,meetings,teachers,teacherDateOverrides]);

  // "tid|day|period" → meeting[] のマップ（教員ビューのセルに会議バッジを表示）
  const meetingCellMap=useMemo(()=>{
    const map={};
    meetings.forEach(m=>{
      (m.teacherIds||[]).forEach(tid=>{
        const k=`${tid}|${m.day}|${m.period}`;
        if(!map[k])map[k]=[];
        map[k].push(m);
      });
    });
    return map;
  },[meetings]);
  const saveBase=(u,keepOpen=false)=>{setBaseH(p=>p.map(e=>e.id===u.id?u:e));if(!keepOpen){setLastEdited(modal?.hk||null);setModal(null);}};
  const addBase=e=>{
    const{_openModal,...entry}=e; // _openModalフラグは保存しない
    const newId=Date.now();
    setBaseH(p=>{
      // altWeekが設定されている場合：同スロット同学級でも別エントリとして共存
      if(entry.altWeek){
        const dup=p.find(x=>x.day===entry.day&&x.period===entry.period&&entry.classIds.some(c=>x.classIds.includes(c))&&x.altWeek===entry.altWeek);
        if(dup)return p.map(x=>x.id===dup.id?{...x,...entry,id:x.id}:x);
        return[...p,{...entry,id:newId}];
      }
      // altWeek未設定（毎週）の場合：同スロット同学級の毎週エントリを上書き
      const dup=p.find(x=>x.day===entry.day&&x.period===entry.period&&entry.classIds.some(c=>x.classIds.includes(c))&&!x.altWeek);
      if(dup)return p.map(x=>x.id===dup.id?{...x,...entry,id:x.id}:x);
      return[...p,{...entry,id:newId}];
    });
    setLastEdited(modal?.hk||null);
    if(!_openModal)setModal(null); // _openModalフラグがある場合はモーダルを閉じない
  };
  const delBase=id=>{setBaseH(p=>p.filter(e=>e.id!==id));setLastEdited(null);setModal(null);};
  const saveChange=c=>{
    const nc=new Set(c.classIds);
    const patDay=getPatDay(c.date,c.period);
    const patPer=getPatPeriod(c.date,c.period);
    const matchesBase=!c.isBlocked&&!!patDay&&c.classIds.length>0&&
      c.classIds.every(cid=>{
        const b=base.find(e=>e.day===patDay&&e.period===patPer&&e.classIds.includes(cid));
        if(!b)return false;
        const tA=JSON.stringify([...(b.teacherIds||[])].sort());
        const tB=JSON.stringify([...(c.teacherIds||[])].sort());
        return b.subject===c.subject&&tA===tB;
      });
    setChangesH(p=>{
      const filtered=p.filter(x=>
        // isBlocked（出張・休日など）は授業変更で消さない
        x.isBlocked||!(x.date===c.date&&x.period===c.period&&x.classIds.some(id=>nc.has(id))));
      if(matchesBase)return filtered;
      return[...filtered,{...c,id:Date.now()}];
    });
    // ── 授業者一覧ビューでの「学級が空になった」検出 ──
    // 変更前にその学級×時限に先生がいたが、変更後は誰もいない場合に通知
    if(c.date&&!c.isBlocked&&view==='day'){
      const prevTeachers=(changes.filter(x=>x.date===c.date&&x.period===c.period&&x.classIds.some(id=>nc.has(id))&&!x._removed&&!x.isBlocked).flatMap(x=>x.teacherIds||[]));
      const newTeachers=matchesBase?[]:c.teacherIds||[];
      if(prevTeachers.length>0&&newTeachers.length===0){
        // 変更後にその学級に担当先生がいるか確認
        const dow=dowOf(c.date);
        const baseHasTeacher=dow&&base.some(e=>e.day===patDay&&e.period===patPer&&e.classIds.some(id=>nc.has(id))&&(e.teacherIds||[]).length>0);
        if(!baseHasTeacher){
          const emptyClassId=[...nc][0];
          setEmptyClassNotice({classId:emptyClassId,period:c.period,date:c.date});
          setTimeout(()=>setEmptyClassNotice(null),8000);
        }
      }
    }
    setLastEdited(modal?.hk||null);
    setModal(null);
  };
  const clearChange=id=>{setChangesH(p=>p.filter(c=>c.id!==id));setLastEdited(null);setModal(null);};

  // ── 祝日一括適用 ─────────────────────────────────────────────────────────
  const applyHolidayBatch=(holidays,targetCids,targetPeriods)=>{
    // holidays: [{date:"YYYY-MM-DD", name:"昭和の日"}, ...]
    saveHistory();
    setChanges(prev=>{
      let result=[...prev];
      const allCids=targetCids||(classes.map(c=>c.id));
      const allPeriods=targetPeriods||[1,2,3,4,5,6];
      holidays.forEach(({date,name})=>{
        allPeriods.forEach(p=>{
          // 同じnoteの既存エントリのみ削除（出張・欠課などは残す）
          result=result.filter(x=>!(x.date===date&&x.period===p&&x.isBlocked&&x.note===name&&x.classIds.some(cid=>allCids.includes(cid))));
          // 全学級に休日エントリを追加
          allCids.forEach(cid=>{
            result.push({
              id:Date.now()+Math.random()*1e6|0,
              date,period:p,classIds:[cid],
              teacherIds:[],subject:"",
              isSubst:false,isBlocked:true,note:name,
            });
          });
        });
      });
      return result;
    });
  };

  // ── 登録済み休業日の一括削除 ──────────────────────────────────────────────
  const removeBatchBlocked=(noteSet)=>{
    saveHistory();
    setChanges(prev=>prev.filter(c=>!(c.isBlocked&&noteSet.has(c.note||"(理由なし)"))));
  };

  const switchPeriod=(newId,{clearHistory=true}={})=>{
    if(newId===activePeriodId)return;
    const cur=saveRef.current;
    skipHistoryRef.current=true; // 期間切替によるbase変化を履歴に記録しない
    // 現在の base を退避
    setSavedPeriodBases(prev=>({...prev,[cur.activePeriodId]:cur.base}));
    // 現在の各先生の asgn を退避（name/id/avail は共通、asgn だけ期間ごとに保存）
    const asgnSnapshot={};
    cur.teachers.forEach(t=>{asgnSnapshot[t.id]=t.asgn||[];});
    setSavedPeriodTeacherAsgns(prev=>({...prev,[cur.activePeriodId]:asgnSnapshot}));
    // 新しい期間の base を復元（なければ現在のbaseをそのままコピー）
    const newBase=cur.savedPeriodBases[newId]??[...cur.base];
    setBase(newBase);
    // 新しい期間の asgn を復元（なければ現在の asgn をそのままコピー）
    const newAsgnMap=cur.savedPeriodTeacherAsgns[newId];
    if(newAsgnMap){
      setTeachers(prev=>prev.map(t=>({...t,asgn:newAsgnMap[t.id]??t.asgn??[]})));
    }
    setActivePeriodId(newId);
    // 手動切替のみ undo 履歴をクリア（自動切替では保持する）
    if(clearHistory){
      historyRef.current=[];
      redoRef.current=[];
      setHistoryLen(0);
    }else{
      skipHistoryRef.current=true; // 自動切替でも base 変化を1回分スキップ
    }
  };

  const addPeriod=()=>{
    const newId="period-"+Date.now();
    const name=window.prompt("新しい期間の名前を入力してください","期間");
    if(!name)return;
    // 現在のbaseをスナップショットとして追加
    setSavedPeriodBases(prev=>({...prev,[newId]:[...base]}));
    // 現在の asgn をスナップショットとして追加
    const asgnSnapshot={};
    teachers.forEach(t=>{asgnSnapshot[t.id]=t.asgn||[];});
    setSavedPeriodTeacherAsgns(prev=>({...prev,[newId]:asgnSnapshot}));
    setPeriodDefs(prev=>[...prev,{id:newId,name,startDate:null,endDate:null}]);
  };

  const deletePeriod=(id)=>{
    if(periodDefs.length<=1){alert("最低1つの期間が必要です");return;}
    if(!window.confirm("この期間を削除しますか？（この期間の基本時間割データも削除されます）"))return;
    if(activePeriodId===id){
      // 別の期間に切り替え
      const other=periodDefs.find(p=>p.id!==id);
      switchPeriod(other.id);
    }
    setPeriodDefs(prev=>prev.filter(p=>p.id!==id));
    setSavedPeriodBases(prev=>{const n={...prev};delete n[id];return n;});
    setSavedPeriodTeacherAsgns(prev=>{const n={...prev};delete n[id];return n;});
  };

  // ── 時限パターン一括設定 ──────────────────────────────────────────────────
  const applyPeriodPattern=(targetDates,patternDay,targetPeriods,patternPeriod=null)=>{
    saveHistory();
    setDayPatterns(prev=>{
      let next=[...prev];
      targetDates.forEach(date=>{
        const existing=next.find(p=>p.date===date)||{date,useDay:dowOf(date)||'月'};
        const newPeriods={...(existing.periods||{})};
        targetPeriods.forEach(p=>{
          if(patternDay===null){
            // リセット
            delete newPeriods[String(p)];
          }else{
            // patternPeriodが指定されていれば、その時限の授業を使う。なければ同じ時限番号
            newPeriods[String(p)]={day:patternDay,period:patternPeriod!==null?patternPeriod:p};
          }
        });
        next=next.filter(x=>x.date!==date);
        const noCustom=Object.keys(newPeriods).length===0;
        const isDefault=!existing.useDay||existing.useDay===dowOf(date);
        if(!(noCustom&&isDefault)){
          next.push({...existing,periods:newPeriods});
        }
      });
      return next;
    });
  };

  // ── ② 一括休日・欠課設定 ─────────────────────────────────────────────────
  const applyBatchBlock=(targetDates,targetClassIds,targetPeriods,reason,removeMode,oldReason=null)=>{
    saveHistory();
    setChanges(prev=>{
      let result=[...prev];
      // 編集モードの場合、旧名称のエントリを全削除してから新規登録
      if(oldReason&&oldReason!==reason){
        result=result.filter(x=>!(x.isBlocked&&x.note===oldReason));
      } else if(oldReason){
        // 同名の場合も全削除してから新規登録（日付の増減に対応）
        result=result.filter(x=>!(x.isBlocked&&x.note===oldReason));
      }
      targetDates.forEach(date=>{
        targetPeriods.forEach(p=>{
          // 既存エントリ削除（同名以外のものも含め対象日時の同classIdsを削除）
          result=result.filter(x=>!(x.date===date&&x.period===p&&x.classIds.some(cid=>targetClassIds.includes(cid))&&x.isBlocked&&x.note===reason));
          if(!removeMode){
            targetClassIds.forEach((cid,i)=>{
              result.push({
                id:Date.now()+Math.random()*1e6|0,
                date,period:p,classIds:[cid],
                teacherIds:[],subject:"",
                isSubst:false,isBlocked:true,note:reason,
              });
            });
          }
        });
      });
      return result;
    });
  };

  setSelClsRef.current=setSelCls;

  // 🔗 リンク外れ検出（base内でlinkGroupがずれている、または週間変更で片方だけ移動されている）
  const brokenLinkGroups=useMemo(()=>{
    const broken=new Set();
    // baseモード：同じlinkGroupの全エントリが同じday+periodか確認
    const lgFirst={};
    base.forEach(e=>{
      if(!e.linkGroup)return;
      if(!lgFirst[e.linkGroup])lgFirst[e.linkGroup]={day:e.day,period:e.period};
      else if(lgFirst[e.linkGroup].day!==e.day||lgFirst[e.linkGroup].period!==e.period)broken.add(e.linkGroup);
    });
    // 週間変更モード：各日付でlinkGroupパートナーが同じperiodに表示されているか確認
    if(dateMode&&dates.length>0){
      dates.forEach(dt=>{
        const dtDow=dowOf(dt);
        const dayLgEntries=base.filter(e=>e.linkGroup&&e.day===dtDow);
        const lgGroups={};
        dayLgEntries.forEach(e=>{if(!lgGroups[e.linkGroup])lgGroups[e.linkGroup]=[];lgGroups[e.linkGroup].push(e);});
        Object.entries(lgGroups).forEach(([lg,entries])=>{
          const periods=entries.map(e=>{
            // changesで別periodに移動されているか
            const moved=changes.find(c=>c.date===dt&&!c._removed&&!c.isBlocked
              &&(c.classIds||[]).some(cid=>(e.classIds||[]).includes(cid))
              &&(c.teacherIds||[]).some(tid=>(e.teacherIds||[]).includes(tid)));
            if(moved)return moved.period;
            // changesで_removedになっているか
            const removed=changes.find(c=>c.date===dt&&c.period===e.period&&c._removed
              &&(c.classIds||[]).some(cid=>(e.classIds||[]).includes(cid)));
            if(removed)return null;
            return e.period;
          });
          const valid=periods.filter(p=>p!==null);
          if(new Set(valid).size>1)broken.add(lg);
        });
      });
    }
    return broken;
  },[base,changes,dateMode,dates]);

  // 🔗 変更エントリからlinkGroupを補完（_ch=trueの変更エントリはlinkGroupを持たないため、baseから探す）
  const resolveLinkGroup=(entry)=>{
    if(!entry)return undefined;
    if(entry.linkGroup)return entry.linkGroup;
    if(!entry._ch)return undefined;
    // 変更エントリの場合、同じclassIds+teacherIdsを持つbaseエントリからlinkGroupを探す
    const eCids=entry.classIds||[];
    const eTids=entry.teacherIds||[];
    return base.find(e=>
      e.linkGroup&&
      eCids.length>0&&eTids.length>0&&
      eCids.every(cid=>(e.classIds||[]).includes(cid))&&
      (e.classIds||[]).length===eCids.length&&
      eTids.some(tid=>(e.teacherIds||[]).includes(tid))
    )?.linkGroup;
  };

  const dragAnalysis=useMemo(()=>{
    if(!dragVisual)return null;
    const srcHk=dragVisual.srcHk;
    const srcCell=cellDataRef.current[srcHk];
    if(!srcCell?.entry)return null;
    const srcCids=new Set(srcCell.entry.classIds||[]);
    const srcPeriod=srcCell.dc.period;
    const srcDay=dateMode?dowOf(srcCell.dc.date||""):srcCell.dc.day;
    const result={[srcHk]:{type:"src"}};
    try{
      Object.entries(cellDataRef.current).forEach(([hk,cell])=>{
        if(hk===srcHk)return;
        const{entry:tgt,dc}=cell;
        if(tgt?.isBlocked){result[hk]={type:"blocked"};return;}
        const tgtPeriod=dc.period;
        const tgtDay=dateMode?dowOf(dc.date||""):dc.day;
        if(!tgtDay){result[hk]={type:"blocked"};return;}
        // 教員ビュー: 異なる先生の列は「直接交換できる駒」のみ許可
        // （駒なし、または共通クラスを持たない駒は不可）
        if(srcCell.dc.matchTid&&dc.matchTid&&dc.matchTid!==srcCell.dc.matchTid){
          if(!tgt||tgt.isBlocked||tgt._removed){result[hk]={type:"blocked"};return;}
          const sharedCidsCross=(srcCell.entry.classIds||[]).filter(cid=>(tgt.classIds||[]).includes(cid));
          if(sharedCidsCross.length===0){result[hk]={type:"blocked"};return;}
        }
        // 学級ビュー: 異なる学級の列にはドロップ不可
        if(srcCell.dc.matchCid&&dc.matchCid&&dc.matchCid!==srcCell.dc.matchCid){result[hk]={type:"blocked"};return;}
        // 3コマ候補（紫ハイライト）
        if(tgt&&chainCandidatesRef.current.some(c=>c.id===tgt.id)){result[hk]={type:"chain",chainSubject:tgt.subject||""};return;}

        // ── 競合チェック ──
        // dateMode: base + changes（_removed でキャンセルされていないもの）を両方確認
        // baseMode: base のみ
        let othersInSlot;
        if(dateMode){
          // 1) changes の lesson エントリ（対象日・時限）
          const chgLessons=changes.filter(c=>
            c.date===dc.date&&c.period===tgtPeriod&&
            !c._removed&&!c.isBlocked&&
            c.id!==srcCell.entry.id&&c.id!==tgt?.id
          );
          // 2) base エントリ（その曜日・時限、changesで_removedされていないもの）
          const baseAtSlot=base.filter(e=>{
            if(e.day!==tgtDay||e.period!==tgtPeriod)return false;
            if(e.id===srcCell.entry.id||e.id===tgt?.id)return false;
            if(e.isBlocked)return false;
            const cancelled=changes.some(c=>
              c.date===dc.date&&c.period===tgtPeriod&&c._removed&&
              (c.classIds||[]).some(cid=>(e.classIds||[]).includes(cid))
            );
            return !cancelled;
          });
          othersInSlot=[...chgLessons,...baseAtSlot];
        }else{
          othersInSlot=base.filter(e=>
            e.day===tgtDay&&e.period===tgtPeriod&&
            e.id!==srcCell.entry.id&&e.id!==tgt?.id
          );
        }

        // クラス競合
        const conflictCids=[...(srcCell.entry.classIds||[])].filter(cid=>
          othersInSlot.some(e=>(e.classIds||[]).includes(cid))
        );
        // 先生競合（dateMode では changes も含め確認）
        const srcTidsArr=srcCell.entry.teacherIds||[];
        const conflictTids=srcTidsArr.filter(tid=>
          othersInSlot.some(e=>(e.teacherIds||[]).includes(tid))
        );
        // 先生の不在・非常勤チェック（avail設定）
        const unavailTids=srcTidsArr.filter(tid=>{
          const t=teachers.find(x=>x.id===tid);
          return t&&!isSlotAvailable(t,tgtDay,tgtPeriod,dc.date||null,teacherDateOverrides);
        });

        // クラス競合・不在は最優先（先生競合より前）
        if(conflictCids.length>0||unavailTids.length>0){
          // 重複相手エントリを特定（パルス表示用）
          const conflictEntries=othersInSlot.filter(e=>(e.classIds||[]).some(c=>conflictCids.includes(c))||(e.teacherIds||[]).some(t=>conflictTids.includes(t)));
          result[hk]={type:"conflict",conflictClasses:conflictCids,unavailTids,conflictEntries};
        }else{
          // 🔗 連動リンクの競合チェック（先生競合より優先：退かして移動できる場合を提案）
          const linkGroup=resolveLinkGroup(srcCell.entry);
          const linkedEntries=linkGroup
            ?base.filter(e=>e.linkGroup===linkGroup&&e.id!==srcCell.entry.id&&!(tgt&&e.id===tgt.id))
            :[];
          const linkConflict=linkedEntries.length>0&&linkedEntries.some(e=>{
            return base.some(b=>
              b.day===tgtDay&&b.period===tgtPeriod&&
              (b.classIds||[]).some(cid=>(e.classIds||[]).includes(cid))&&
              b.id!==e.id&&b.id!==srcCell.entry.id&&!(tgt&&b.id===tgt.id)
            );
          });
          if(linkConflict){
            // 連動先が埋まっている → 邪魔している駒が srcDc に移動できるか確認
            const canSwapToSrc=linkedEntries.every(le=>{
              const blocker=base.find(b=>
                b.day===tgtDay&&b.period===tgtPeriod&&
                (b.classIds||[]).some(cid=>(le.classIds||[]).includes(cid))&&
                b.id!==le.id&&b.id!==srcCell.entry.id&&!(tgt&&b.id===tgt.id)
              );
              if(!blocker)return true;
              const linkedIds=new Set(linkedEntries.map(e=>e.id));
              const blockerTids=new Set(blocker.teacherIds||[]);
              // クラス競合チェック（移動後に空くエントリを除外）
              const classConflict=base.find(b=>
                b.day===srcDay&&b.period===srcPeriod&&
                (b.classIds||[]).some(cid=>(blocker.classIds||[]).includes(cid))&&
                b.id!==blocker.id&&b.id!==srcCell.entry.id&&!linkedIds.has(b.id)
              );
              if(classConflict)return false;
              // 先生競合チェック（blocker の先生が srcDc に既に別授業を持っていないか）
              const teacherConflict=blockerTids.size>0&&base.find(b=>
                b.day===srcDay&&b.period===srcPeriod&&
                (b.teacherIds||[]).some(tid=>blockerTids.has(tid))&&
                b.id!==blocker.id&&b.id!==srcCell.entry.id&&!linkedIds.has(b.id)
              );
              if(teacherConflict)return false;
              // 非常勤・出勤不可チェック（blocker の先生が srcDc の曜日・時限に出勤できるか）
              const teacherUnavail=[...blockerTids].some(tid=>{
                const t=base.find?.(b=>b)&&teachers.find(x=>x.id===tid);
                return t&&!isSlotAvailable(t,srcDay,srcPeriod);
              });
              return !teacherUnavail;
            });
            if(canSwapToSrc){
              // 邪魔している駒を srcDc に退かせる → 推奨スワップとして水色表示
              const blockerNames=linkedEntries.map(le=>{
                const blocker=base.find(b=>
                  b.day===tgtDay&&b.period===tgtPeriod&&
                  (b.classIds||[]).some(cid=>(le.classIds||[]).includes(cid))&&
                  b.id!==le.id&&b.id!==srcCell.entry.id
                );
                return blocker?.subject||"";
              }).filter(Boolean).join('・');
              result[hk]={type:"linkswap",blockerNames,srcDay,srcPeriod};
            }else{
              // 退かすことができない → 黄色警告
              const names=linkedEntries
                .filter(e=>base.some(b=>b.day===tgtDay&&b.period===tgtPeriod&&(b.classIds||[]).some(cid=>(e.classIds||[]).includes(cid))&&b.id!==e.id&&b.id!==srcCell.entry.id&&!(tgt&&b.id===tgt.id)))
                .map(e=>e.subject).join('・');
              result[hk]={type:"linkwarn",linkNames:names};
            }
          }else if(conflictTids.length>0){
            // linkGroup で解決できない先生競合
            result[hk]={type:"conflict",conflictClasses:[],unavailTids:[]};
          }else if(!tgt){
            result[hk]={type:"empty"};
          }else if((srcCell.entry.teacherIds||[]).some(tid=>(tgt.teacherIds||[]).includes(tid))){
            // 同じ先生の別授業が入っている → 自動入れ替えせず重複として扱う（option A）
            result[hk]={type:"conflict",conflictClasses:[],unavailTids:[],conflictEntries:[tgt]};
          }else{
            // 入れ替え候補: 押し出される tgt が移動元スロットへ来たときの競合も検証する。
            // （合同授業・複数先生のコマでは、移動元で別の学級/先生と重なることがある）
            const srcDate=srcCell.dc.date||null;
            let srcOccupants;
            if(dateMode){
              const chgAtSrc=changes.filter(c=>c.date===srcDate&&c.period===srcPeriod&&!c._removed&&!c.isBlocked&&c.id!==srcCell.entry.id&&c.id!==tgt.id);
              const overridden=new Set(chgAtSrc.flatMap(c=>c.classIds||[]));
              const baseAtSrc=base.filter(e=>e.day===srcDay&&e.period===srcPeriod&&!e.isBlocked&&e.id!==srcCell.entry.id&&e.id!==tgt.id&&!(e.classIds||[]).some(cid=>overridden.has(cid)));
              srcOccupants=[...chgAtSrc,...baseAtSrc];
            }else{
              srcOccupants=base.filter(e=>e.day===srcDay&&e.period===srcPeriod&&!e.isBlocked&&e.id!==srcCell.entry.id&&e.id!==tgt.id);
            }
            const tgtCidsArr=tgt.classIds||[];
            const tgtTidsArr=tgt.teacherIds||[];
            const swapClassConflict=srcOccupants.filter(e=>(e.classIds||[]).some(cid=>tgtCidsArr.includes(cid))).flatMap(e=>(e.classIds||[]).filter(cid=>tgtCidsArr.includes(cid)));
            const swapTeacherConflict=srcOccupants.some(e=>(e.teacherIds||[]).some(tid=>tgtTidsArr.includes(tid)));
            const swapTchUnavail=tgtTidsArr.some(tid=>{const t=teachers.find(x=>x.id===tid);return t&&!isSlotAvailable(t,srcDay,srcPeriod,srcDate,teacherDateOverrides);});
            if(swapClassConflict.length>0||swapTeacherConflict||swapTchUnavail){
              // 入れ替えると移動元で重複が出る → swapにせず重複として表示
              result[hk]={type:"conflict",conflictClasses:[...new Set(swapClassConflict)],unavailTids:[],conflictEntries:[tgt],swapBlocked:true};
            }else{
              result[hk]={type:"swap",swapSubject:tgt.subject||"",swapClasses:tgt.classIds||[]};
            }
          }
        }
      });
    }catch(e){console.error("dragAnalysis error",e);}
    return result;
  },[dragVisual,base,changes,teachers,chainVersion]);

  const unplacedLessons=useMemo(()=>{
    const result=[];
    teachers.forEach(teacher=>{
      (teacher.asgn||[]).forEach(({c,s,n=1})=>{
        if(!n||n===0)return;
        const placed=base.filter(e=>
          (e.teacherIds||[]).includes(teacher.id)&&
          (e.classIds||[]).includes(c)&&
          e.subject===s
        ).length;
        const remaining=Math.max(0,n-placed);
        for(let i=0;i<remaining;i++){
          result.push({
            id:`unplaced-${teacher.id}-${c}-${s}-${i}`,
            teacherIds:[teacher.id],classIds:[c],subject:s,
            _isUnplaced:true,_teacherName:teacher.name,
          });
        }
      });
    });
    return result;
  },[teachers,base]);

  // ── 原子的適用（週間モード専用）─────────────────────────────────────────
  // plan: [{entry, from:{date,period}, to:{date,period}}] の配列。
  // 主役・重複相手・玉突きで動く全駒の最終位置を、トライアル開始前のスナップショットを
  // 土台に一度の setChanges で構築する。逐次移動と違い _removed マーカーの消し合いが
  // 起きないため、同一学級・先生の回転（例: 国語↔社会↔自立）でも土台が復活しない。
  applyPlanAtomicRef.current=(plan)=>{
    try{sbSaveBackup(saveRef.current,'玉突き移動前の自動バックアップ').catch(e=>console.error('chain backup failed',e));}catch(_){}
    const snap=trialSnapRef.current;
    const snapChanges=(snap?snap.changes:currentRef.current.changes)||[];
    const ts=Date.now();
    const sameSlot=(a,b)=>a&&b&&a.date===b.date&&a.period===b.period;
    // from===to の無駄手を除外
    const moves=(plan||[]).filter(m=>m&&m.entry&&m.to&&!(m.from&&sameSlot(m.from,m.to)));
    if(moves.length===0)return;
    const movedIdSet=new Set(moves.map(m=>m.entry.id));
    // スナップショット時点で「変更レッスン（_removed/isBlockedでない）」として存在するid
    // → これらは変更由来の駒。動かす際はレッスンを除去するだけでよい（土台は元の_removedが隠したまま）。
    const liveChgLessonIds=new Set(snapChanges.filter(c=>!c._removed&&!c.isBlocked).map(c=>c.id));
    const isChangeLesson=e=>liveChgLessonIds.has(e.id);
    // 1) 動かす駒自身の変更レッスンをスナップショットから除去（idベース）。
    //    無関係な変更・既存の_removedマーカーはすべて保持する（消し合いを起こさない）。
    let u=snapChanges.filter(c=>!movedIdSet.has(c.id));
    // 2) 各 to に新レッスンを追加
    moves.forEach((m,i)=>{
      u.push({id:ts+i*4,date:m.to.date,period:m.to.period,
        classIds:m.entry.classIds,teacherIds:m.entry.teacherIds,
        subject:m.entry.subject,isSubst:false,note:"（玉突き移動）"});
    });
    // 3) 各 from に _removed マーカー（ベース駒のみ）。
    //    その from が他の駒で埋まっても、レッスンが優先表示されマーカーは土台隠しとして無害。
    //    変更レッスン由来の駒はマーカー不要（手順1でレッスンを消し、土台は元の_removedで隠れたまま）。
    moves.forEach((m,i)=>{
      if(!m.from)return;
      if(isChangeLesson(m.entry))return;
      u.push({id:ts+i*4+2,date:m.from.date,period:m.from.period,
        classIds:m.entry.classIds,teacherIds:m.entry.teacherIds||[],
        subject:"",isSubst:false,_removed:true,note:""});
    });
    setChangesH(()=>u);
    setMovedIds(new Set(moves.map((m,i)=>ts+i*4)));
  };

  moveExecRef.current=(srcEntry,srcDc,tgtEntry,tgtDc)=>{
    if(!srcEntry||srcEntry.isBlocked)return;
    const srcIsBench=srcDc.benchIdx!=null;
    const srcIsUnplaced=!!srcEntry._isUnplaced;
    const tgtIsBench=tgtDc.benchIdx!=null;
    // ドラッグ移動前にSupabaseバックアップ（ベンチ操作・未配置は除く）
    if(!srcIsBench&&!srcIsUnplaced&&!tgtIsBench){
      sbSaveBackup(saveRef.current,'移動前の自動バックアップ').catch(e=>console.error('move backup failed',e));
    }

    if(srcIsUnplaced&&!tgtIsBench){
      const lessonCid=srcEntry.classIds?.[0];
      const lessonTid=srcEntry.teacherIds?.[0];
      if(!tgtDc.day&&!tgtDc.date)return;
      if(!dateMode){
        const existing=base.find(e=>
          e.day===tgtDc.day&&e.period===tgtDc.period&&
          (e.classIds||[]).some(c=>(srcEntry.classIds||[]).includes(c))
        );
        if(existing){
          setBench(p=>{const n=[...p];const slot=n.findIndex(x=>!x);if(slot>=0)n[slot]={...existing,_benchDay:existing.day,_benchPeriod:existing.period};return n;});
          setBaseH(p=>p.map(e=>e.id===existing.id
            ?{...srcEntry,id:e.id,day:tgtDc.day,period:tgtDc.period,_isUnplaced:undefined,_teacherName:undefined}
            :e));
        }else{
          setBaseH(p=>[...p,{...srcEntry,id:Date.now(),day:tgtDc.day,period:tgtDc.period,_isUnplaced:undefined,_teacherName:undefined}]);
        }
        if(lessonCid)setSelClsRef.current?.(lessonCid);
      }else{
        const srcCids=new Set(srcEntry.classIds||[]);
        setChangesH(p=>[...p.filter(c=>!(c.date===tgtDc.date&&c.period===tgtDc.period&&(c.classIds||[]).some(id=>srcCids.has(id)))),
          {id:Date.now(),date:tgtDc.date,period:tgtDc.period,classIds:srcEntry.classIds,teacherIds:srcEntry.teacherIds,subject:srcEntry.subject,isSubst:false,note:""}]);
        if(lessonCid)setSelClsRef.current?.(lessonCid);
      }
      return;
    }
    if(srcIsBench&&tgtIsBench){
      setBench(p=>{const n=[...p];n[tgtDc.benchIdx]=p[srcDc.benchIdx];n[srcDc.benchIdx]=p[tgtDc.benchIdx];return n;});
      return;
    }
    if(srcIsBench&&!tgtIsBench){
      const sameSlot=dateMode?(srcEntry._benchDate===tgtDc.date&&srcEntry._benchPeriod===tgtDc.period)
        :(srcEntry._benchDay===tgtDc.day&&srcEntry._benchPeriod===tgtDc.period);
      // 待機(bench)からセルへ移動：元の待機スロットをクリア
      setBench(p=>{const n=[...p];n[srcDc.benchIdx]=null;return n;});
      if(!dateMode){
        setBaseH(p=>p.map(e=>tgtEntry&&e.id===tgtEntry.id?{...e,day:srcEntry._benchDay,period:srcEntry._benchPeriod}
          :{...e}).concat(
          base.find(e=>e.day===tgtDc.day&&e.period===tgtDc.period&&(tgtDc.matchCid?(e.classIds||[]).includes(tgtDc.matchCid):(e.teacherIds||[]).includes(tgtDc.matchTid)))?[]
          :[{...srcEntry,id:Date.now(),day:tgtDc.day,period:tgtDc.period,_benchDay:undefined,_benchPeriod:undefined}]
        ));
        setBaseH(p=>{
          const existing=p.find(e=>e.day===tgtDc.day&&e.period===tgtDc.period&&(tgtDc.matchCid?(e.classIds||[]).includes(tgtDc.matchCid):(e.teacherIds||[]).includes(tgtDc.matchTid)));
          if(existing) return p.map(e=>e.id===existing.id?{...srcEntry,id:e.id,day:tgtDc.day,period:tgtDc.period}:e);
          return[...p,{...srcEntry,id:Date.now(),day:tgtDc.day,period:tgtDc.period}];
        });
      }else{
        const srcCids=new Set(srcEntry.classIds||[]);
        const srcTids=new Set(srcEntry.teacherIds||[]);
        // 【v8_7_14】往復（待機→元のスロットへ戻す）の二重化防止。
        //   戻す先に「自分のbase」があり、それを隠す _removed がある＝元へ戻るケースは、
        //   _removed を消せば base が復活するので lesson は足さない（base＋lesson の自己重複を防ぐ）。
        //   移動側 1968-1980 と同じ判定。
        const tgtDow=dowOf(tgtDc.date||"");
        const tgtHasOwnBase=base.some(b=>!b.isBlocked&&!b._removed
          &&b.day===tgtDow&&b.period===tgtDc.period
          &&(b.classIds||[]).some(id=>srcCids.has(id))
          &&(b.teacherIds||[]).some(id=>srcTids.has(id)));
        const tgtHasRemovedForSrc=changes.some(c=>c._removed
          &&c.date===tgtDc.date&&c.period===tgtDc.period
          &&(c.classIds||[]).some(id=>srcCids.has(id))
          &&((c.teacherIds||[]).length===0||(c.teacherIds||[]).some(id=>srcTids.has(id))));
        const isReturnToBase=tgtHasOwnBase&&tgtHasRemovedForSrc;
        setChangesH(p=>{
          const filtered=p.filter(c=>!(c.date===tgtDc.date&&c.period===tgtDc.period&&(c.classIds||[]).some(id=>srcCids.has(id))));
          if(isReturnToBase)return filtered; // base が復活するので lesson は足さない
          return[...filtered,
            {id:Date.now(),date:tgtDc.date,period:tgtDc.period,classIds:srcEntry.classIds,teacherIds:srcEntry.teacherIds,subject:srcEntry.subject,isSubst:false,note:"（待機から移動）"}];
        });
      }
      return;
    }
    if(!srcIsBench&&tgtIsBench){
      const benchEntry={...srcEntry,_benchDay:srcDc.day,_benchPeriod:srcDc.period,_benchDate:srcDc.date};
      setBench(p=>{const n=[...p];const old=n[tgtDc.benchIdx];n[tgtDc.benchIdx]=benchEntry;return n;});
      if(!dateMode){
        setBaseH(p=>p.filter(e=>e.id!==srcEntry.id));
      }else{
        const srcCids=new Set(srcEntry.classIds||[]);
        const srcTids=new Set(srcEntry.teacherIds||[]);
        const srcIsChange=srcEntry._ch===true; // 【v8_7_12】移動元が変更(change)かベース(base)か
        const ts=Date.now();
        setChangesH(p=>{
          const filtered=p.filter(c=>{
            if(c.date!==srcDc.date||c.period!==srcDc.period)return true; // 別スロットは保持
            // 【v8_7_12】出張等の isBlocked マーカーは残す（待機後も元の時限に出張だけ残すため）
            if(c.isBlocked)return true;
            // 移動元自身の lesson（classIds かつ teacherIds 一致）のみ除去（巻き添え防止）
            if(!c._removed&&(c.classIds||[]).some(id=>srcCids.has(id))&&(c.teacherIds||[]).some(id=>srcTids.has(id)))return false;
            // 【v8_7_12】自分宛の _removed は、ベース隠しを付け直すので除去（重複防止）。それ以外は保持。
            if(c._removed&&(c.classIds||[]).some(id=>srcCids.has(id))&&!srcIsChange){
              const tIds=c.teacherIds||[];
              if(tIds.length===0||tIds.some(id=>srcTids.has(id)))return false;
            }
            return true; // 他の先生・他学級の変更や _removed は保持
          });
          // 【v8_7_12】元がベースコマなら _removed を付与してベースを隠す
          //   （待機へ送ったのに元の授業が残る不具合の修正。移動側 2089-2092 と同じ作法）
          if(!srcIsChange){
            filtered.push({id:ts,date:srcDc.date,period:srcDc.period,
              classIds:srcEntry.classIds,teacherIds:srcEntry.teacherIds||[],subject:"",isSubst:false,_removed:true,note:""});
          }
          return filtered;
        });
      }
      return;
    }
    const sameSlot=dateMode
      ?(srcDc.date===tgtDc.date&&srcDc.period===tgtDc.period)
      :(srcDc.day===tgtDc.day&&srcDc.period===tgtDc.period);
    if(sameSlot)return;
    if(!dateMode){
      // 呼び出し側が指定したスワップ相手(tgtEntry)のみをスワップ対象にする。
      // null のときはスワップしない（option A：同一先生セルへのドロップ等で勝手に入れ替えない）。
      const tgt=tgtEntry?base.find(e=>e.id===tgtEntry.id)||null:null;
      // 🔗 連動グループの処理
      const linkGroup=srcEntry.linkGroup;
      const linkedEntries=linkGroup
        ? base.filter(e=>e.linkGroup===linkGroup&&e.id!==srcEntry.id&&!(tgt&&e.id===tgt.id))
        : [];
      if(linkGroup) console.log('[🔗]',{linkGroup,linkedCount:linkedEntries.length,linked:linkedEntries.map(e=>e.subject)});
      // 連動エントリの移動先が空いているか確認
      const blockedLinks=linkedEntries.filter(e=>{
        const conflict=base.find(b=>b.day===tgtDc.day&&b.period===tgtDc.period&&
          (b.classIds||[]).some(cid=>(e.classIds||[]).includes(cid))&&b.id!==e.id&&b.id!==srcEntry.id&&!(tgt&&b.id===tgt.id));
        return!!conflict;
      });
      if(blockedLinks.length>0){
        // 連動先が埋まっている → 調整モーダルを開く
        // 各 blockedLink について、邪魔しているエントリと候補スロットを計算
        const adjustItems=blockedLinks.map(linkedEntry=>{
          // tgtDc に居て邪魔しているエントリ
          const blocker=base.find(b=>
            b.day===tgtDc.day&&b.period===tgtDc.period&&
            (b.classIds||[]).some(cid=>(linkedEntry.classIds||[]).includes(cid))&&
            b.id!==linkedEntry.id&&b.id!==srcEntry.id&&!(tgt&&b.id===tgt.id)
          );
          // blocker の移動候補：
          // 1) srcEntry の元の場所（推奨）
          // 2) blocker のクラスが空いている他のスロット
          const candidates=[];
          const linkedIds=new Set(linkedEntries.map(e=>e.id));
          // 推奨：srcEntry の元の場所（自立・英語が移動後に空くので除外して判定）
          const blockerTidsSet=new Set(blocker?.teacherIds||[]);
          // 先生の出勤可否チェック（非常勤など）
          const srcTeacherAvail=[...blockerTidsSet].every(tid=>{
            const t=teachers.find(x=>x.id===tid);
            return !t||isSlotAvailable(t,srcDc.day,srcDc.period);
          });
          const srcSlotConflict=blocker&&(!srcTeacherAvail||base.find(b=>
            b.day===srcDc.day&&b.period===srcDc.period&&
            (b.classIds||[]).some(cid=>(blocker.classIds||[]).includes(cid))&&
            b.id!==blocker.id&&b.id!==srcEntry.id&&!linkedIds.has(b.id)
          ));
          if(!srcSlotConflict){
            candidates.push({day:srcDc.day,period:srcDc.period,recommended:true});
          }
          // その他の空きスロット（blocker のクラスと先生が両方空いている）
          const allDays=['月','火','水','木','金'];
          const allPeriods=[1,2,3,4,5,6];
          const blockerCids=new Set(blocker?.classIds||[]);
          const blockerTids=new Set(blocker?.teacherIds||[]);
          allDays.forEach(d=>allPeriods.forEach(p=>{
            if(d===srcDc.day&&p===srcDc.period)return; // 推奨は既に追加
            if(d===tgtDc.day&&p===tgtDc.period)return; // 移動先は除外
            if(!blocker)return;
            // blocker のクラスと競合する授業がある（自分・srcEntry・linkedEntries は除外）
            const classConflict=base.some(b=>
              b.day===d&&b.period===p&&
              (b.classIds||[]).some(cid=>blockerCids.has(cid))&&
              b.id!==blocker.id&&b.id!==srcEntry.id&&!linkedIds.has(b.id)
            );
            if(classConflict)return;
            // blocker の先生が出勤できるか（非常勤設定）
            const teacherAvail=[...blockerTids].every(tid=>{
              const t=teachers.find(x=>x.id===tid);
              return !t||isSlotAvailable(t,d,p);
            });
            if(!teacherAvail)return;
            // blocker の先生が既に別の授業を持っているか
            const teacherConflict=blockerTids.size>0&&base.some(b=>
              b.day===d&&b.period===p&&
              (b.teacherIds||[]).some(tid=>blockerTids.has(tid))&&
              b.id!==blocker.id&&b.id!==srcEntry.id&&!linkedIds.has(b.id)
            );
            if(teacherConflict)return;
            candidates.push({day:d,period:p,recommended:false});
          }));
          return{linkedEntry,blocker,candidates};
        });
        setLinkAdjustModal({
          srcEntry,srcDc,tgtDc,tgt,
          linkedEntries,adjustItems,
          linkGroup,
        });
        return;
      }
      setBaseH(p=>p.map(e=>{
        if(e.id===srcEntry.id)return{...e,day:tgtDc.day,period:tgtDc.period,_keepBlocked:undefined};
        if(tgt&&e.id===tgt.id)return{...e,day:srcDc.day,period:srcDc.period};
        // 連動エントリも同じ先へ移動（swapの場合は srcDc へ）
        if(linkedEntries.find(l=>l.id===e.id)){
          return{...e,day:tgtDc.day,period:tgtDc.period};
        }
        return e;
      }));
      // _keepBlocked: 移動元の isBlocked エントリ（出張など）は残す（削除しない）
      // dateMode の場合は changes 側の isBlocked も維持される（何もしない）
      // 動いた駒の id を記録
      const newIds=new Set([srcEntry.id,...linkedEntries.map(e=>e.id)]);
      if(tgt) newIds.add(tgt.id);
      setMovedIds(newIds);
      // 連動通知
      if(linkedEntries.length>0){
        const names=linkedEntries.map(e=>`${e.subject}（${(e.classIds||[]).map(c=>classes.find(x=>x.id===c)?.name||c).join('・')}）`).join('、');
        setLinkNotice({text:`🔗 ${names} も ${tgtDc.day}曜${tgtDc.period}限に移動しました`,type:"info"});
        setTimeout(()=>setLinkNotice(null),4000);
      }
    }else{
      const srcCids=new Set(srcEntry.classIds||[]);
      const tgtCids=new Set(tgtEntry?.classIds||[]);
      const srcTids=new Set(srcEntry.teacherIds||[]);
      const tgtTids=new Set(tgtEntry?.teacherIds||[]);
      // _ch=true → 「変更コマ」(changeから来た)  _ch=false/undefined → 「ベースコマ」
      const srcIsChange=srcEntry._ch===true;
      const tgtIsChange=!!(tgtEntry?._ch===true);
      const hasSwap=!!(tgtEntry&&!tgtEntry.isBlocked&&!tgtEntry._removed);
      const ts=Date.now();

      // 【往復移動の検出】移動先(tgtDc)に「自分のbase」があり、かつそれを隠す _removed change がある場合
      //   → これは「A→B→A」で元の位置に戻ってきたケース。
      //     _removed を消せば base が復活して元通りになるので、lesson は追加しない（二重化防止）。
      const tgtDow=dateMode?dowOf(tgtDc.date||""):tgtDc.day;
      const tgtHasOwnBase=base.some(b=>!b.isBlocked&&!b._removed
        &&b.day===tgtDow&&b.period===tgtDc.period
        &&(b.classIds||[]).some(id=>srcCids.has(id))
        &&(b.teacherIds||[]).some(id=>srcTids.has(id)));
      const tgtHasRemovedForSrc=dateMode&&changes.some(c=>c._removed
        &&c.date===tgtDc.date&&c.period===tgtDc.period
        &&(c.classIds||[]).some(id=>srcCids.has(id))
        &&((c.teacherIds||[]).length===0||(c.teacherIds||[]).some(id=>srcTids.has(id))));
      const isReturnToBase=!hasSwap&&tgtHasOwnBase&&tgtHasRemovedForSrc;

      // 🔗 連動グループの処理（週間変更モード）
      const linkGroup=resolveLinkGroup(srcEntry);
      const linkedEntries=linkGroup
        ?base.filter(e=>e.linkGroup===linkGroup&&e.id!==srcEntry.id&&!(tgtEntry&&e.id===tgtEntry.id))
        :[];
      const tgtDateDow=dowOf(tgtDc.date||"");
      const lgAllIds=new Set([srcEntry.id,...linkedEntries.map(e=>e.id)]);
      // 連動先の移動先での競合チェック
      const blockedLinks=linkedEntries.filter(le=>{
        const leCids=new Set(le.classIds||[]);
        const leTids=new Set(le.teacherIds||[]);
        // changesに競合するlessonがあるか
        const chgConflict=changes.some(c=>c.date===tgtDc.date&&c.period===tgtDc.period
          &&!c._removed&&!c.isBlocked
          &&((c.classIds||[]).some(id=>leCids.has(id))||(c.teacherIds||[]).some(id=>leTids.has(id))));
        if(chgConflict)return true;
        // baseに競合する授業があり、changesでキャンセルされていないか
        const baseConflict=base.some(b=>{
          if(lgAllIds.has(b.id))return false;
          if(b.day!==tgtDateDow||b.period!==tgtDc.period)return false;
          if(b.isBlocked||b._removed)return false;
          if(!(b.classIds||[]).some(id=>leCids.has(id))&&!(b.teacherIds||[]).some(id=>leTids.has(id)))return false;
          const removedByChange=changes.some(c=>c.date===tgtDc.date&&c.period===tgtDc.period&&c._removed
            &&(c.classIds||[]).some(id=>(b.classIds||[]).includes(id)));
          return !removedByChange;
        });
        return baseConflict;
      });

      setChangesH(p=>{
        let u=p.filter(c=>{
          // ════ tgtDc ════
          if(c.date===tgtDc.date&&c.period===tgtDc.period){
            // srcEntry 自身の既存 lesson（teacherIdで絞る）
            if(!c._removed&&(c.classIds||[]).some(id=>srcCids.has(id))&&(c.teacherIds||[]).some(id=>srcTids.has(id))) return false;
            // srcCids の _removed：自分宛（teacherIds一致 or 旧形式 teacherIds=[]）のみ除去
            if(c._removed&&(c.classIds||[]).some(id=>srcCids.has(id))){
              const tIds=c.teacherIds||[];
              if(tIds.length===0||tIds.some(id=>srcTids.has(id))) return false; // 自分宛のみ除去
            }
            if(hasSwap){
              // tgtEntry 自身の lesson（teacherIdで絞る）
              if(!c._removed&&(c.classIds||[]).some(id=>tgtCids.has(id))&&(c.teacherIds||[]).some(id=>tgtTids.has(id))) return false;
              // tgtCids の _removed を除去するのは tgtEntry がベースコマのときだけ
              // かつ自分宛（teacherIds一致 or 旧形式）のみ
              if(c._removed&&(c.classIds||[]).some(id=>tgtCids.has(id))&&!tgtIsChange){
                const tIds=c.teacherIds||[];
                if(tIds.length===0||tIds.some(id=>tgtTids.has(id))) return false;
              }
            }
            // 🔗 競合なしの連動エントリの tgtDc を除去
            if(blockedLinks.length===0){
              for(const le of linkedEntries){
                const leCids=new Set(le.classIds||[]);const leTids=new Set(le.teacherIds||[]);
                if(!c._removed&&(c.classIds||[]).some(id=>leCids.has(id))&&(c.teacherIds||[]).some(id=>leTids.has(id)))return false;
                if(c._removed&&(c.classIds||[]).some(id=>leCids.has(id))){const tIds=c.teacherIds||[];if(tIds.length===0||tIds.some(id=>leTids.has(id)))return false;}
              }
            }
            return true;
          }
          // ════ srcDc ════
          if(c.date===srcDc.date&&c.period===srcDc.period){
            // _keepBlocked: 出張セルからドラッグした場合、isBlockedエントリは残す
            if(srcEntry._keepBlocked&&c.isBlocked) return true;
            // srcEntry 自身の lesson（teacherIdで絞る）
            if(!c._removed&&(c.classIds||[]).some(id=>srcCids.has(id))&&(c.teacherIds||[]).some(id=>srcTids.has(id))) return false;
            // srcCids の _removed：srcEntry がベースコマのとき かつ 自分宛のみ除去
            if(c._removed&&(c.classIds||[]).some(id=>srcCids.has(id))&&!srcIsChange){
              const tIds=c.teacherIds||[];
              if(tIds.length===0||tIds.some(id=>srcTids.has(id))) return false;
            }
            if(hasSwap){
              // tgtEntry 自身の lesson（重複防止のため teacherIdで絞る）
              if(!c._removed&&(c.classIds||[]).some(id=>tgtCids.has(id))&&(c.teacherIds||[]).some(id=>tgtTids.has(id))) return false;
              // tgtCids の _removed は残す（他の先生のベースを隠している可能性）
            }
            // 🔗 競合なしの連動エントリの srcDc を除去
            if(blockedLinks.length===0){
              for(const le of linkedEntries){
                const leCids=new Set(le.classIds||[]);const leTids=new Set(le.teacherIds||[]);
                if(!c._removed&&(c.classIds||[]).some(id=>leCids.has(id))&&(c.teacherIds||[]).some(id=>leTids.has(id)))return false;
                if(c._removed&&(c.classIds||[]).some(id=>leCids.has(id))){const tIds=c.teacherIds||[];if(tIds.length===0||tIds.some(id=>leTids.has(id)))return false;}
              }
            }
            return true; // 他の先生の変更エントリは保持
          }
          return true;
        });

        // ① srcEntry → tgtDc
        //    ただし往復で元の位置に戻る場合（isReturnToBase）は、tgtDcの_removedが除去されて
        //    baseが復活するので、lessonは追加しない（base+lessonの二重化＝自己重複を防ぐ）。
        if(!isReturnToBase){
          u.push({id:ts,date:tgtDc.date,period:tgtDc.period,
            classIds:srcEntry.classIds,teacherIds:srcEntry.teacherIds,
            subject:srcEntry.subject,isSubst:false,note:"（移動）"});
        }

        if(hasSwap){
          // ② tgtEntry → srcDc（lesson を _removed より先に push して優先度を確保）
          u.push({id:ts+1,date:srcDc.date,period:srcDc.period,
            classIds:tgtEntry.classIds,teacherIds:tgtEntry.teacherIds,
            subject:tgtEntry.subject,isSubst:false,note:"（移動）"});
        }

        // ③ srcDc の _removed：srcEntry がベースコマのときだけ追加
        //    teacherIds を持たせることで「その先生のbaseだけを隠す」マーカーになる
        if(!srcIsChange){
          u.push({id:ts+2,date:srcDc.date,period:srcDc.period,
            classIds:srcEntry.classIds,teacherIds:srcEntry.teacherIds||[],subject:"",isSubst:false,_removed:true,note:""});
        }

        if(hasSwap){
          // ④ tgtDc の _removed：tgtEntry がベースコマのときだけ追加
          if(!tgtIsChange){
            u.push({id:ts+3,date:tgtDc.date,period:tgtDc.period,
              classIds:tgtEntry.classIds,teacherIds:tgtEntry.teacherIds||[],subject:"",isSubst:false,_removed:true,note:""});
          }
        }

        // 🔗 競合なしの場合、連動エントリ分も changes に追加
        if(blockedLinks.length===0){
          linkedEntries.forEach((le,i)=>{
            u.push({id:ts+10+i*2,date:tgtDc.date,period:tgtDc.period,
              classIds:le.classIds,teacherIds:le.teacherIds,subject:le.subject,isSubst:false,note:"（連動移動）"});
            u.push({id:ts+10+i*2+1,date:srcDc.date,period:srcDc.period,
              classIds:le.classIds,teacherIds:le.teacherIds||[],subject:"",isSubst:false,_removed:true,note:""});
          });
        }
        return u;
      });
      // 動いた駒の id を記録（lesson のみ。_removed は対象外）
      const newIds=new Set([ts]);
      if(hasSwap) newIds.add(ts+1);
      setMovedIds(newIds);

      // 🔗 連動通知
      if(linkedEntries.length>0){
        if(blockedLinks.length>0){
          const names=blockedLinks.map(e=>e.subject).join('・');
          setLinkNotice({text:`⚠️ 「${names}」は移動先が塞がっているためリンクを外して移動しました`,type:"warn"});
        }else{
          const names=linkedEntries.map(e=>`${e.subject}（${(e.classIds||[]).map(c=>classes.find(x=>x.id===c)?.name||c).join('・')}）`).join('、');
          setLinkNotice({text:`🔗 ${names} も ${tgtDc.period}限に連動移動しました`,type:"info"});
        }
        setTimeout(()=>setLinkNotice(null),4000);
      }
    }
  };

  const undo=()=>{
    if(historyRef.current.length===0)return;
    const prev=historyRef.current[historyRef.current.length-1];
    historyRef.current=historyRef.current.slice(0,-1);
    redoRef.current=[...redoRef.current,JSON.parse(JSON.stringify(currentRef.current))];
    skipHistoryRef.current=true; // undo/redoはuseEffectの自動履歴保存をスキップ
    setBase(prev.base);
    setChanges(prev.changes);
    if(prev.dayPatterns!==undefined)setDayPatterns(prev.dayPatterns);
    setHistoryLen(historyRef.current.length);
  };
  const redo=()=>{
    if(redoRef.current.length===0)return;
    const next=redoRef.current[redoRef.current.length-1];
    redoRef.current=redoRef.current.slice(0,-1);
    historyRef.current=[...historyRef.current,JSON.parse(JSON.stringify(currentRef.current))];
    skipHistoryRef.current=true; // undo/redoはuseEffectの自動履歴保存をスキップ
    setBase(next.base);
    setChanges(next.changes);
    if(next.dayPatterns!==undefined)setDayPatterns(next.dayPatterns);
    setHistoryLen(historyRef.current.length);
  };

  // ── 3コマ回転の競合チェック ──────────────────────────────────────────────
  // 指定の先生たちが day/period に移動した場合、会議・不在・空き設定で競合するか
  const hasSlotConflict=useRef((teacherIds,day,period)=>{
    if(!day||!period)return false;
    for(const tid of teacherIds){
      // 会議との競合
      if(saveRef.current?.meetings?.some(m=>m.day===day&&m.period===period&&(m.teacherIds||[]).includes(tid)))return true;
      // 不在スロット
      const teacher=(saveRef.current?.teachers||[]).find(t=>t.id===tid);
      if(teacher&&!isSlotAvailable(teacher,day,period))return true;
    }
    // isBlocked エントリとの競合
    if((saveRef.current?.base||[]).some(e=>e.day===day&&e.period===period&&e.isBlocked&&teacherIds.some(tid=>(e.teacherIds||[]).includes(tid))))return true;
    return false;
  });

  // 3コマ候補を計算して競合フィルタリング
  const computeChainCandidates=useRef((srcEntry,srcDc,tgtEntry,tgtDc)=>{
    const sharedCids=(srcEntry.classIds||[]).filter(cid=>(tgtEntry?.classIds||[]).includes(cid));
    if(sharedCids.length===0)return[];
    const srcSlotKey=`${srcDc.day}|${srcDc.period}`;
    const tgtSlotKey=`${tgtDc.day}|${tgtDc.period}`;
    const baseSnap=saveRef.current?.base||[];
    // 学級競合チェック：指定スロットにclassIdsの授業が他にあるか（3コマ当事者を除く）
    const hasClassConflictAt=(classIds,day,period,excludeIds)=>{
      const cidSet=new Set(classIds);
      return baseSnap.some(b=>
        b.day===day&&b.period===period&&!b.isBlocked&&!b._removed&&
        !excludeIds.has(b.id)&&
        (b.classIds||[]).some(cid=>cidSet.has(cid))
      );
    };
    return baseSnap.filter(e=>{
      if(e.id===srcEntry.id||e.id===tgtEntry.id)return false;
      if(e.isBlocked||e._removed)return false;
      if(!sharedCids.some(cid=>(e.classIds||[]).includes(cid)))return false;
      const slotKey=`${e.day}|${e.period}`;
      if(slotKey===srcSlotKey||slotKey===tgtSlotKey)return false;
      const involved=new Set([srcEntry.id,tgtEntry.id,e.id]);
      // 先生競合チェック
      if(hasSlotConflict.current(tgtEntry.teacherIds||[],e.day,e.period))return false;
      if(hasSlotConflict.current(e.teacherIds||[],srcDc.day,srcDc.period))return false;
      if(hasSlotConflict.current(srcEntry.teacherIds||[],tgtDc.day,tgtDc.period))return false;
      // 学級競合チェック（3コマ当事者以外の授業と被っていないか）
      if(hasClassConflictAt(tgtEntry.classIds||[],e.day,e.period,involved))return false;  // B→Cスロット
      if(hasClassConflictAt(e.classIds||[],srcDc.day,srcDc.period,involved))return false;  // C→Aスロット
      if(hasClassConflictAt(srcEntry.classIds||[],tgtDc.day,tgtDc.period,involved))return false; // A→Bスロット
      return true;
    }).slice(0,5);
  });
  const executeChainSwap=(srcEntry,srcDc,tgtEntry,tgtDc,cEntry,cDc)=>{
    saveHistory();
    // 3コマ回転前にSupabaseバックアップ（復元可能にする）
    sbSaveBackup(saveRef.current,'3コマ回転前の自動バックアップ').catch(e=>console.error('chain backup failed',e));
    if(!dateMode){
      setBase(p=>p.map(e=>{
        if(e.id===srcEntry.id)return{...e,day:tgtDc.day,period:tgtDc.period};
        if(e.id===tgtEntry.id)return{...e,day:cDc.day,period:cDc.period};
        if(e.id===cEntry.id) return{...e,day:srcDc.day,period:srcDc.period};
        return e;
      }));
      // 動いた駒の id を記録（3コマ全部）
      setMovedIds(new Set([srcEntry.id,tgtEntry.id,cEntry.id]));
      // 何を動かしたかのサマリー通知
      {
        const _cn=id=>classes.find(c=>c.id===id)?.name||id;
        const lbl=e=>`${e.subject}（${(e.classIds||[]).map(_cn).join('・')}）`;
        showMoveNotice('🔄 3コマ回転で移動しました',[
          `1. ${lbl(srcEntry)}${srcDc.day}曜${srcDc.period}限 → ${tgtDc.day}曜${tgtDc.period}限`,
          `2. ${lbl(tgtEntry)}${tgtDc.day}曜${tgtDc.period}限 → ${cDc.day}曜${cDc.period}限`,
          `3. ${lbl(cEntry)}${cDc.day}曜${cDc.period}限 → ${srcDc.day}曜${srcDc.period}限`,
        ]);
      }
    }else{
      const srcCids=new Set(srcEntry.classIds||[]);
      const tgtCids=new Set(tgtEntry.classIds||[]);
      const cCids  =new Set(cEntry.classIds||[]);
      const ts=Date.now();
      setChanges(p=>{
        // 3スロット分の既存changeを除去
        let u=p.filter(c=>
          !(c.date===tgtDc.date&&c.period===tgtDc.period&&(c.classIds||[]).some(id=>srcCids.has(id)||tgtCids.has(id)))&&
          !(c.date===cDc.date &&c.period===cDc.period &&(c.classIds||[]).some(id=>tgtCids.has(id)||cCids.has(id)))&&
          !(c.date===srcDc.date&&c.period===srcDc.period&&(c.classIds||[]).some(id=>srcCids.has(id)||cCids.has(id)))
        );
        // A→tgt, B→c, C→src の3コマ分を追加
        u.push({id:ts+0,date:tgtDc.date,period:tgtDc.period,classIds:srcEntry.classIds,teacherIds:srcEntry.teacherIds,subject:srcEntry.subject,isSubst:false,note:"（3コマ回転）"});
        u.push({id:ts+1,date:srcDc.date,period:srcDc.period,classIds:tgtEntry.classIds,teacherIds:tgtEntry.teacherIds,subject:tgtEntry.subject,isSubst:false,note:"（3コマ回転）"});
        u.push({id:ts+2,date:cDc.date, period:cDc.period, classIds:cEntry.classIds,  teacherIds:cEntry.teacherIds,  subject:cEntry.subject,  isSubst:false,note:"（3コマ回転）"});
        // _removed で元ベースを隠す（各エントリ）
        [[srcEntry,tgtDc],[tgtEntry,cDc],[cEntry,srcDc]].forEach(([e,dc],i)=>{
          u.push({id:ts+10+i,date:dc.date,period:dc.period,classIds:e.classIds,teacherIds:e.teacherIds||[],subject:"",isSubst:false,_removed:true,note:""});
        });
        return u;
      });
      // 動いた駒の id を記録（3コマ全部の lesson id）
      setMovedIds(new Set([ts,ts+1,ts+2]));
    }
    setChainModal(null);
  };

  // ── 玉突き候補の探索（通常モード）──────────────────────────────────────────
  // 移動元の空き枠(hole)を、同じクラスの別のコマをずらして埋める連鎖を探す。
  // 深さ1〜3手（ドラッグ含め最大4手）。各手は「先生がその枠で空いている」コマのみ。
  // クラスまたぎ対応：候補の先生が別クラスの授業で塞がっている場合、
  //   その授業を空き枠へ「どかす」手（+1手）を含む複合候補も生成する。
  // pos: 仮想位置マップ（id→{day,period}）で「移動済み」を表現し、実データは触らない。
  const computeFillHoleChains=useRef((srcEntry,srcDc,tgtDc)=>{
    try{
      const baseSnap=saveRef.current?.base||[];
      const benchIds=new Set((benchRef.current||[]).filter(Boolean).map(b=>b.id));
      const entries=baseSnap.filter(e=>!benchIds.has(e.id)&&!e._removed);
      // 主役(srcEntry)と同一内容＝教科・学級・教師が全て一致する駒は、動かしても無意味なので連鎖から除外
      const _hC=srcEntry.classIds||[],_hT=srcEntry.teacherIds||[];
      const sameAsSrc=x=>{const xc=x.classIds||[],xt=x.teacherIds||[];return x.subject===srcEntry.subject&&xc.length===_hC.length&&xc.every(c=>_hC.includes(c))&&xt.length===_hT.length&&xt.every(t=>_hT.includes(t));};
      // 学校で使用する曜日×時限（設定があれば最優先、未設定なら使用実績から推定）
      const ssCfg=saveRef.current?.schoolSlots;
      const usedSlots=new Set(baseSnap.filter(b=>b.day&&b.period).map(b=>`${b.day}-${b.period}`));
      const slotUsable=(d,p)=>ssCfg?((ssCfg[d]||[]).includes(p)):usedSlots.has(`${d}-${p}`);
      const eposOf=(pos,e)=>pos[e.id]||{day:e.day,period:e.period};
      // 指定スロットにcidSetのクラスの授業が他にあるか（仮想位置で判定）
      const occupiedBy=(pos,day,period,cidSet,exclude)=>entries.some(e=>{
        if(exclude.has(e.id)||e.isBlocked)return false;
        const p=eposOf(pos,e);
        return p.day===day&&p.period===period&&(e.classIds||[]).some(c=>cidSet.has(c));
      });
      // 指定スロットで先生と重なる授業の一覧（会議・不在は別途hasSlotConflictで判定）
      const lessonConflictsAt=(pos,day,period,tids,exclude)=>{
        const tidSet=new Set(tids||[]);
        if(tidSet.size===0)return[];
        return entries.filter(e=>{
          if(exclude.has(e.id)||e.isBlocked)return false;
          const p=eposOf(pos,e);
          return p.day===day&&p.period===period&&(e.teacherIds||[]).some(t=>tidSet.has(t));
        });
      };
      // どかす先の探索：cのクラスが空き＆先生が空き（会議・不在・授業すべて確認）
      const findRelocations=(pos,c,excludeIds,holeSlot,cap)=>{
        const out=[];
        const cp=eposOf(pos,c);
        const cCids=new Set(c.classIds||[]);
        for(const d of DAYS){
          for(const per of PERIODS){
            if(out.length>=cap)return out;
            if(!slotUsable(d,per))continue; // 学校として使っていない時限は除外
            if(d===holeSlot.day&&per===holeSlot.period)continue;
            if(d===cp.day&&per===cp.period)continue;
            if(occupiedBy(pos,d,per,cCids,excludeIds))continue;
            if(hasSlotConflict.current(c.teacherIds||[],d,per))continue;
            if(lessonConflictsAt(pos,d,per,c.teacherIds||[],excludeIds).length>0)continue;
            out.push({day:d,period:per});
          }
        }
        return out;
      };
      // 1状態から打てる手（単純な埋め手 / どかし＋埋めの複合手）を列挙
      const expandState=(st,budget)=>{
        const holeCids=st.hole.cids||[];
        const out=[];
        if(holeCids.length===0)return out;
        let simpleCount=0;
        for(const e of entries){
          if(out.length>=10)break;
          if(e.isBlocked||e.altWeek||e.linkGroup)continue; // A/B週・連動コマは対象外（安全のため）
          if(sameAsSrc(e))continue; // 主役と同一内容の駒は埋めても無意味
          if(st.moved.has(e.id))continue;
          const p=eposOf(st.pos,e);
          if(!p.day||!p.period)continue;
          if(p.day===st.hole.day&&p.period===st.hole.period)continue;
          // holeの全クラスをカバーするコマのみ（同一クラス内のずらし）
          if(!holeCids.every(cid=>(e.classIds||[]).includes(cid)))continue;
          const exclude=new Set([...st.moved,e.id]);
          // 合同授業など、holeに含まれない追加クラスもholeスロットで空きが必要
          const extraCids=new Set((e.classIds||[]).filter(c=>!holeCids.includes(c)));
          if(extraCids.size>0&&occupiedBy(st.pos,st.hole.day,st.hole.period,extraCids,exclude))continue;
          // 会議・不在・出張は動かせない → 即除外
          if(hasSlotConflict.current(e.teacherIds||[],st.hole.day,st.hole.period))continue;
          const confs=lessonConflictsAt(st.pos,st.hole.day,st.hole.period,e.teacherIds||[],exclude);
          if(confs.length===0){
            // 単純な埋め手（1手）
            if(simpleCount>=8)continue;
            simpleCount++;
            out.push({
              steps:[{entry:e,from:{day:p.day,period:p.period},to:{day:st.hole.day,period:st.hole.period},kind:'fill'}],
              newHole:{day:p.day,period:p.period,cids:e.classIds||[]},
              movedIds:[e.id],
              posPatch:{[e.id]:{day:st.hole.day,period:st.hole.period}},
            });
          }else if(confs.length===1&&budget>=2){
            // クラスまたぎ複合手（2手）：先生の重なり相手cを空き枠へどかしてからeで埋める
            const c=confs[0];
            if(c.isBlocked||c.altWeek||c.linkGroup||st.moved.has(c.id))continue;
            if(sameAsSrc(c))continue; // 主役と同一内容の駒はどかしても無意味
            const posAfterE={...st.pos,[e.id]:{day:st.hole.day,period:st.hole.period}};
            const exclude2=new Set([...st.moved,e.id,c.id]);
            const relocs=findRelocations(posAfterE,c,exclude2,st.hole,2);
            const cp=eposOf(st.pos,c);
            for(const r of relocs){
              out.push({
                steps:[
                  {entry:c,from:{day:cp.day,period:cp.period},to:r,kind:'displace'},
                  {entry:e,from:{day:p.day,period:p.period},to:{day:st.hole.day,period:st.hole.period},kind:'fill'},
                ],
                newHole:{day:p.day,period:p.period,cids:e.classIds||[]},
                movedIds:[c.id,e.id],
                posPatch:{[c.id]:r,[e.id]:{day:st.hole.day,period:st.hole.period}},
              });
            }
          }
        }
        return out;
      };
      const chains=[];
      const MAXSTEPS=3,MAX_STATES=40,MAX_CHAINS=24;
      let frontier=[{
        hole:{day:srcDc.day,period:srcDc.period,cids:srcEntry.classIds||[]},
        moved:new Set([srcEntry.id]),
        path:[],
        pos:{[srcEntry.id]:{day:tgtDc.day,period:tgtDc.period}},
      }];
      while(frontier.length>0&&chains.length<MAX_CHAINS){
        const next=[];
        for(const st of frontier){
          if(chains.length>=MAX_CHAINS)break;
          const budget=MAXSTEPS-st.path.length;
          if(budget<=0)continue;
          const exps=expandState(st,budget);
          for(const ex of exps){
            if(ex.steps.length>budget)continue;
            if(chains.length>=MAX_CHAINS)break;
            const path=[...st.path,...ex.steps];
            chains.push({steps:path,finalHole:ex.newHole});
            if(path.length<MAXSTEPS&&next.length<MAX_STATES){
              next.push({
                hole:ex.newHole,
                moved:new Set([...st.moved,...ex.movedIds]),
                path,
                pos:{...st.pos,...ex.posPatch},
              });
            }
          }
        }
        frontier=next;
      }
      chains.sort((a,b)=>a.steps.length-b.steps.length);
      return chains;
    }catch(err){console.error("fillHoleChains error",err);return[];}
  });
  // 玉突き連鎖を実行（全手を一度のsetBaseで適用 → undo一回で戻せる）
  const executeFillHoleChain=(chain)=>{
    sbSaveBackup(saveRef.current,'玉突き移動前の自動バックアップ').catch(e=>console.error('fillhole backup failed',e));
    const moveMap=new Map(chain.steps.map(s=>[s.entry.id,s.to]));
    setBaseH(p=>p.map(e=>{
      const to=moveMap.get(e.id);
      return to?{...e,day:to.day,period:to.period}:e;
    }));
    setMovedIds(new Set(chain.steps.map(s=>s.entry.id)));
    // 何を動かしたかのサマリー通知
    {
      const _cn=id=>classes.find(c=>c.id===id)?.name||id;
      const _tn=id=>teachers.find(t=>t.id===id)?.name||"";
      const lines=chain.steps.map((s,i)=>
        `${i+1}. ${s.kind==='displace'?'↪どかす ':''}${s.entry.subject}（${(s.entry.classIds||[]).map(_cn).join('・')}・${(s.entry.teacherIds||[]).map(_tn).filter(Boolean).join('・')}先生）${s.from.day}曜${s.from.period}限 → ${s.to.day}曜${s.to.period}限`);
      showMoveNotice('🧩 玉突きで移動しました',lines);
    }
    setFillHoleModal(null);
  };

  useEffect(()=>{
    const onKey=e=>{
      if((e.ctrlKey||e.metaKey)&&!e.shiftKey&&e.key==='z'){
        e.preventDefault();undo();
      }
      if((e.ctrlKey||e.metaKey)&&(e.key==='y'||(e.shiftKey&&e.key==='z')||e.key==='Z')){
        e.preventDefault();redo();
      }
    };
    window.addEventListener('keydown',onKey);
    return()=>window.removeEventListener('keydown',onKey);
  },[]);

  useEffect(()=>{
    const findHkEl=(x,y)=>{
      const fn=document.elementsFromPoint?.bind(document)||((x,y)=>{const e=document.elementFromPoint(x,y);return e?[e]:[];});
      return fn(x,y).find(el=>el.getAttribute?.('data-hk'))||document.elementFromPoint(x,y)?.closest?.('[data-hk]')||null;
    };
    const findTabEl=(x,y)=>{
      const els=document.elementsFromPoint?.(x,y)||[];
      for(const el of els){
        if(el.getAttribute?.('data-tab-type'))return el;
        const p=el.closest?.('[data-tab-type]');
        if(p)return p;
      }
      return null;
    };
    let scrollInterval=null;
    let px=0,py=0;
    const EDGE=100,SPEED=12;
    const startScroll=()=>{
      if(scrollInterval)return;
      scrollInterval=setInterval(()=>{
        if(!dragRef.current){stopScroll();return;}
        const vy=py<EDGE?-SPEED:py>window.innerHeight-EDGE?SPEED:0;
        const vx=px<EDGE?-SPEED:px>window.innerWidth-EDGE?SPEED:0;
        if(vy||vx){
          window.scrollBy({left:vx,top:vy,behavior:'instant'});
          const tableWrap=document.querySelector('[style*="overflow-x"]');
          if(tableWrap&&vx)tableWrap.scrollLeft+=vx;
        }
      },16);
    };
    const stopScroll=()=>{clearInterval(scrollInterval);scrollInterval=null;};
    let tabTimer=null;
    let lastTabEl=null;
    const clearTabTimer=()=>{clearTimeout(tabTimer);tabTimer=null;};
    const onMove=e=>{
      if(!dragRef.current)return;
      px=e.clientX;py=e.clientY;
      const{startX,startY}=dragRef.current;
      const dist=Math.hypot(e.clientX-startX,e.clientY-startY);
      if(!dragRef.current.moved&&dist>6){
        dragRef.current.moved=true;
        startScroll();
      }
      if(!dragRef.current.moved)return;
      const srcHkSnap=dragRef.current?.srcHk;
      const labelSnap=dragRef.current?.entry?.subject||"？";
      setDragVisual(p=>p?{...p,x:e.clientX,y:e.clientY}:{srcHk:srcHkSnap,x:e.clientX,y:e.clientY,label:labelSnap});
      const td=findHkEl(e.clientX,e.clientY);
      const h=td?.getAttribute('data-hk')||null;
      if(hoverHkRef.current!==h){
        hoverHkRef.current=h;
        setHoverHk(h);
        // ホバー先がconflictなら重複相手のhkを特定してパルス表示
        const hDa=h?dragAnalysis?.[h]:null;
        if(hDa?.type==="conflict"&&hDa.conflictEntries?.length>0){
          const conflictIds=new Set(hDa.conflictEntries.map(e=>e.id));
          const pulseHks=new Set(
            Object.entries(cellDataRef.current)
              .filter(([,c])=>c.entry&&conflictIds.has(c.entry.id))
              .map(([hk])=>hk)
          );
          setConflictPulseHks(pulseHks);
        }else{
          setConflictPulseHks(new Set());
        }
      }
      // 大きくドラッグ（80px超）+ ホバー先に駒がある場合、1秒後に3コマ候補を表示
      if(dist>80&&h&&h!==dragRef.current.srcHk){
        const hoverCell=cellDataRef.current[h];
        const hoverEntry=hoverCell?.entry;
        if(hoverEntry&&!hoverEntry.isBlocked&&!hoverEntry._removed){
          const timerKey=h;
          if(!chainTimerRef.current||chainTimerRef.current._key!==timerKey){
            clearTimeout(chainTimerRef.current?._id);
            const timerId=setTimeout(()=>{
              const src=dragRef.current;
              if(!src)return;
              const tgt=cellDataRef.current[hoverHkRef.current];
              if(!tgt?.entry)return;
              const cands=computeChainCandidates.current(src.entry,src.dc,tgt.entry,tgt.dc);
              chainCandidatesRef.current=cands;
              setChainVersion(v=>v+1);
            },1000);
            chainTimerRef.current={_id:timerId,_key:timerKey};
          }
        }else{
          // ホバー先が空きセルなら候補クリア
          clearTimeout(chainTimerRef.current?._id);
          chainTimerRef.current=null;
          if(chainCandidatesRef.current.length>0){chainCandidatesRef.current=[];setChainVersion(v=>v+1);}
        }
      }else{
        clearTimeout(chainTimerRef.current?._id);
        chainTimerRef.current=null;
        if(chainCandidatesRef.current.length>0){chainCandidatesRef.current=[];setChainVersion(v=>v+1);}
      }
      const tabEl=findTabEl(e.clientX,e.clientY);
      if(tabEl!==lastTabEl){
        clearTabTimer();
        lastTabEl=tabEl;
        if(tabEl){
          // 【v8_7_29】駒をドラッグ中にタブの上を通過しただけで切り替わらないよう、
          //   待ち時間を100msに変更（同じタブに0.1秒以上留まったときだけ切り替える）。
          tabTimer=setTimeout(()=>{
            const t=tabEl.getAttribute('data-tab-type');
            const v=tabEl.getAttribute('data-tab-val');
            if(t==='view')setView(v);
            else if(t==='mode')setDateMode(v==='true');
            else if(t==='cls')setSelCls(v);
            else if(t==='tch')setSelTch(v);
            else if(t==='di')setSelDi(Number(v));
          },100);
        }
      }
    };
    const onUp=e=>{
      if(!dragRef.current)return;
      const src=dragRef.current;
      dragRef.current=null;
      // onUp は useEffect([]) 内のクロージャのため base/changes が初回値で固着する。
      // 常に最新を参照するよう ref から取り直す（重複判定・玉突き探索が古いデータを見ないように）。
      const base=currentRef.current.base;
      const changes=currentRef.current.changes;
      stopScroll();clearTabTimer();lastTabEl=null;
      clearTimeout(chainTimerRef.current?._id);chainTimerRef.current=null;
      if(chainCandidatesRef.current.length>0){chainCandidatesRef.current=[];setChainVersion(v=>v+1);}
      if(!src.moved){
        src.onClick?.();
      }else{
        const td=findHkEl(e.clientX,e.clientY);
        const tgtHk=td?.getAttribute('data-hk');
        if(tgtHk&&tgtHk!==src.srcHk){
          const tgt=cellDataRef.current[tgtHk];
          if(tgt){
            // ── 授業者一覧ビューの禁止操作ガード ──
            // 別の先生の枠は「直接交換（共通クラスあり）」のみ許可
            if(src.dc.matchTid&&tgt.dc.matchTid&&src.dc.matchTid!==tgt.dc.matchTid){
              const tEnt=tgt.entry;
              const shared=(tEnt&&!tEnt.isBlocked&&!tEnt._removed)
                ?(src.entry.classIds||[]).filter(cid=>(tEnt.classIds||[]).includes(cid))
                :[];
              if(shared.length===0){
                setDragVisual(null);hoverHkRef.current=null;setHoverHk(null);
                return; // 視覚的に blocked と表示されたまま無音で中止
              }
            }
            // ── 学級重複チェック ──
            // 移動先で「同じ学級が他の先生にも入っている」場合は警告
            const srcCidsList=src.entry.classIds||[];
            // 同じ先生の別授業が入っているセルへのドロップは「自動入れ替え」にしない（option A）。
            // → 押し出される授業はスワップせず、重複相手としてパネルに出し、移動先を選ばせる。
            const tgtSharesTeacher=tgt.entry&&!tgt.entry.isBlocked&&!tgt.entry._removed
              &&(src.entry.teacherIds||[]).some(tid=>(tgt.entry.teacherIds||[]).includes(tid));
            const tgtIsSwap=tgt.entry&&!tgt.entry.isBlocked&&!tgt.entry._removed&&!tgtSharesTeacher;
            // moveExec へ渡すスワップ相手（同一先生のときは null＝入れ替えしない）
            const tgtForMove=tgtIsSwap?tgt.entry:null;
            const sharedWithTgt=tgtIsSwap?srcCidsList.filter(cid=>(tgt.entry.classIds||[]).includes(cid)):[];
            // 移動先の他の先生のセルで、同じクラスを担当しているものを検出
            const conflictTeachers=[];
            const conflictClasses=new Set();
            const currentClasses=classesRef.current||[];
            const validCidSet=new Set(currentClasses.map(c=>c.id));
            const cnLatest=cid=>currentClasses.find(c=>c.id===cid)?.name||cid;
            // ベンチに入っているエントリのIDセット（base から除去されずに残っているため除外が必要）
            const benchIds=new Set((benchRef.current||[]).filter(Boolean).map(b=>b.id));
            // allと同じロジック: その日全体のchanges classIds に含まれるbaseは除外
            const tgtDate=tgt.dc.date||null;
            const tgtDow=dateModeRef.current?dowOf(tgtDate):tgt.dc.day;
            // 日課パターン対応: tgtDateとtgt.dc.periodからpatDay/patPerを取得
            const tgtPatDay=dateModeRef.current&&tgtDate?getPatDay(tgtDate,tgt.dc.period):tgtDow;
            const tgtPatPer=dateModeRef.current&&tgtDate?getPatPeriod(tgtDate,tgt.dc.period):tgt.dc.period;
            const _base=saveRef.current?.base||base;
            const _changes=saveRef.current?.changes||changes;
            // 変更で隠れる基本時間割を除外する判定は「その時限」のみを見る（スロット単位）。
            // 以前は「その日のどこかに変更がある学級」を一律除外していた（日単位）ため、
            // 例：2年A組に同日の別時限の変更があると、月1限の基本時間割の授業まで判定から外れ、
            // 出張コマを重ねても重複と見なされずパネルが出ない不具合があった。後半(co2)と同じ粒度に揃える。
            // 【v8_7_10】co2(下の収集側)は !c._removed のみ。ここに !c.isBlocked を付けていたため、
            // 出張で授業を別時限へ動かした後（移動元スロットに isBlocked マーカーだけ残る）に、
            // 「上書きあり」と認識できず、移動済みの基本時間割を居るものと誤判定 → 空きスロットへ
            // 動かしても学級重複パネルが誤発生していた。co2 と完全に同じ粒度（!c._removed のみ）に修正。
            const slotChgCids=dateModeRef.current?new Set(_changes.filter(c=>c.date===tgtDate&&c.period===tgt.dc.period&&!c._removed).flatMap(c=>c.classIds||[])):new Set();
            const allAtSlotBase=_base.filter(e=>e.day===tgtPatDay&&e.period===tgtPatPer&&!e.isBlocked&&!benchIds.has(e.id)&&(e2=>!e2.altWeek||!abWeekNowRef.current||e2.altWeek===abWeekNowRef.current)(e)&&![...(e.classIds||[])].some(cid=>slotChgCids.has(cid)));
            const allAtSlotChg=dateModeRef.current?_changes.filter(c=>c.date===tgtDate&&c.period===tgt.dc.period&&!c._removed&&!c.isBlocked):[];
            const allAtSlotForConflict=[...allAtSlotChg,...allAtSlotBase].filter((e,i,a)=>a.findIndex(x=>x.id===e.id)===i);
            srcCidsList.forEach(cid=>{
              if(!validCidSet.has(cid))return; // ゴーストクラスIDは無視
              // 学級別ビューで表示中クラスのセルが空きなら → ghost の可能性あり → スキップ
              if(tgt.dc.matchCid===cid && !tgt.entry)return;
              // gE(.find)は最初の一致しか返さないため、bench より前に ghost が来るとすり抜ける
              // → 全マッチを取得し、bench・自身・swap相手を除いた上で判定
              const allAtSlot=allAtSlotForConflict.filter(e=>(e.classIds||[]).includes(cid));
              const candidates=allAtSlot.filter(e=>
                e.id!==src.entry.id &&       // 自身を除外
                !benchIds.has(e.id) &&        // bench 内エントリを除外
                !(tgtIsSwap&&tgt.entry&&e.id===tgt.entry.id) // swap相手を除外
              );
              // swap相手と同じ学級を共有していても、swap相手「以外」に同じ学級がいる場合は衝突
              if(sharedWithTgt.includes(cid)){
                // candidates から tgt.entry だけを除いた残りがいれば衝突
                const othersWithSameCid=candidates.filter(e=>!(tgtIsSwap&&tgt.entry&&e.id===tgt.entry.id));
                if(othersWithSameCid.length===0)return; // swap相手のみ → 衝突なし（通常swap）
                // swap相手以外にも同じ学級がいる → 衝突として検出
              }
              const currentTeachers=teachersRef.current||[];
              const tnLatest=tid=>currentTeachers.find(x=>x.id===tid)?.name||"";
              // 全候補エントリの先生を表示（matchTid フィルタを撤廃し全員表示）
              const allTids=[...new Set(candidates.flatMap(e=>e.teacherIds||[]))];
              const validTids=allTids.filter(t=>currentTeachers.find(x=>x.id===t));
              if(validTids.length===0)return;
              const tids=validTids.map(t=>tnLatest(t)).filter(Boolean);
              const subjDetail=candidates.map(e=>`${e.subject}`).join('・');
              if(tids.length)conflictTeachers.push(`${tids.join('・')}先生 ${subjDetail}（${cnLatest(cid)}）`);
              conflictClasses.add(cid);
            });
            // ── 重複種別を判定してConflictResolveModalを開く ──
            // 先生重複：移動先で同じ先生が別のクラスを担当しているか
            const srcTidsSet=new Set(src.entry.teacherIds||[]);
            const conflictTeacherEntries=[];
            if(srcTidsSet.size>0){
              const atSlot=allAtSlotForConflict;
              atSlot.forEach(e=>{
                if(e.id===src.entry.id)return;
                if(tgtIsSwap&&tgt.entry&&e.id===tgt.entry.id)return;
                if((e.teacherIds||[]).some(tid=>srcTidsSet.has(tid)))conflictTeacherEntries.push(e);
              });
            }
            const hasClassConflict=conflictClasses.size>0;
            const hasTeacherConflict=conflictTeacherEntries.length>0;
            if(hasClassConflict||hasTeacherConflict){
              // 重複相手エントリを収集（学級重複 or 先生重複）
              const conflictEntryIds=new Set();
              const conflictItems=[];
              srcCidsList.forEach(cid=>{
                if(!validCidSet.has(cid))return;
                const tgtDay2=dateModeRef.current?dowOf(tgt.dc.date):tgt.dc.day;
                const co2=dateModeRef.current?new Set(_changes.filter(c=>c.date===tgt.dc.date&&c.period===tgt.dc.period&&!c._removed).flatMap(c=>c.classIds||[])):new Set();
                const allAtSlot2=[
                  ...(dateModeRef.current?_changes.filter(c=>c.date===tgt.dc.date&&c.period===tgt.dc.period&&(c.classIds||[]).includes(cid)&&!c._removed&&!c.isBlocked):[]),
                  ..._base.filter(e=>e.day===tgtDay2&&e.period===tgt.dc.period&&(e.classIds||[]).includes(cid)&&!e.isBlocked&&(!dateModeRef.current||!co2.has(cid))&&(e2=>!e2.altWeek||!abWeekNowRef.current||e2.altWeek===abWeekNowRef.current)(e)),
                ].filter((e,i,a)=>a.findIndex(x=>x.id===e.id)===i);
                allAtSlot2.filter(e=>e.id!==src.entry.id&&!benchIds.has(e.id)&&!(tgtIsSwap&&tgt.entry&&e.id===tgt.entry.id))
                  .forEach(e=>{if(!conflictEntryIds.has(e.id)){conflictEntryIds.add(e.id);conflictItems.push({entry:e,type:'class',classId:cid});}});
              });
              conflictTeacherEntries.forEach(e=>{if(!conflictEntryIds.has(e.id)){conflictEntryIds.add(e.id);conflictItems.push({entry:e,type:'teacher'});}});
              // 各重複エントリの移動候補を生成（空きスロット）
              const currentTeachersSnap=teachersRef.current||[];
              const ALLD=dateModeRef.current?null:["月","火","水","木","金"];
              const ALLP=[1,2,3,4,5,6];
              
              const moveCandidates=conflictItems.map(item=>{
                const e=item.entry;
                const eCids=new Set(e.classIds||[]);
                const eTids=new Set(e.teacherIds||[]);
                // 移動元の駒(src.entry)も除外IDに含める（移動するとそのスロットは空くため）
                const excludeIds=new Set([e.id,src.entry.id]);
                // IDズレ対策: 移動元スロットにある「主役と同一内容(同学級・同先生)」のエントリも除外。
                // （授業者一覧の週間モードで、ドラッグ駒のidと土台baseのidが一致しない場合がある）
                (()=>{
                  const sP=src.dc.period;
                  const sDay=dateModeRef.current?dowOf(src.dc.date||""):src.dc.day;
                  const mC=src.entry.classIds||[],mT=src.entry.teacherIds||[];
                  const sameContent=x=>{
                    const xc=x.classIds||[],xt=x.teacherIds||[];
                    return xc.length===mC.length&&xc.every(c=>mC.includes(c))&&xt.length===mT.length&&xt.every(t=>mT.includes(t));
                  };
                  base.forEach(b=>{if(b.period===sP&&b.day===sDay&&!b.isBlocked&&sameContent(b))excludeIds.add(b.id);});
                  if(dateModeRef.current)changes.forEach(c=>{if(c.period===sP&&c.date===src.dc.date&&!c._removed&&!c.isBlocked&&sameContent(c))excludeIds.add(c.id);});
                })();
                // 主役(src.entry)と同一内容＝教科・学級・教師がすべて一致する駒は、
                // 玉突きでどかしても「出張等の意図で動かした主役」と入れ替わるだけで無意味。
                // → 連鎖のブロッカー（どかす駒）候補から除外する。
                const _mSubj=src.entry.subject,_mC=src.entry.classIds||[],_mT=src.entry.teacherIds||[];
                const sameAsSrc=x=>{
                  const xc=x.classIds||[],xt=x.teacherIds||[];
                  return x.subject===_mSubj
                    &&xc.length===_mC.length&&xc.every(c=>_mC.includes(c))
                    &&xt.length===_mT.length&&xt.every(t=>_mT.includes(t));
                };
                // 学校で使用する曜日×時限（設定があれば最優先で従う）
                const ssCfg=saveRef.current?.schoolSlots;
                // 基本時間割で実際に使われている枠（全校で1コマでも授業がある曜日・時限）
                // 設定が未設定の場合のみ、この使用実績ヒューリスティックで判定する
                const usedSlotSet=new Set((saveRef.current?.base||base).filter(b=>b.day&&b.period).map(b=>`${b.day}-${b.period}`));
                const slotUsable=(d,p)=>ssCfg?((ssCfg[d]||[]).includes(p)):usedSlotSet.has(`${d}-${p}`);
                const slots=[];
                (ALLD||[]).forEach(d=>{
                  ALLP.forEach(p=>{
                    if(!slotUsable(d,p))return; // 学校として使っていない時限は除外
                    if(d===(e.day||tgt.dc.day)&&p===e.period)return;
                    if(d===tgt.dc.day&&p===tgt.dc.period)return;
                    const abNow=abWeekNowRef.current;
                    const abOk=e=>!e.altWeek||!abNow||e.altWeek===abNow;
                    const __b=saveRef.current?.base||base;
                    const classOk=![...eCids].some(cid=>__b.some(b=>b.day===d&&b.period===p&&(b.classIds||[]).includes(cid)&&!b.isBlocked&&!excludeIds.has(b.id)&&abOk(b)));
                    const teacherOk=![...eTids].some(tid=>{
                      if(__b.some(b=>b.day===d&&b.period===p&&(b.teacherIds||[]).includes(tid)&&!b.isBlocked&&!excludeIds.has(b.id)&&abOk(b)))return true;
                      const t=currentTeachersSnap.find(x=>x.id===tid);
                      return t&&!isSlotAvailable(t,d,p);
                    });
                    // 先生不在チェック（会議・teacherDateOverrides）
                    const meetingOk=![...eTids].some(tid=>teacherDateOverrides&&Object.entries(teacherDateOverrides).some(([dt,ov])=>ov[tid]&&dowOf(dt)===d&&ov[tid][p]===false));
                    if(classOk&&teacherOk&&meetingOk)slots.push({day:d,period:p});
                  });
                });
                // dateModeRef.current用スロット（今週の各日）
                if(dateModeRef.current){
                  // 【v8_7_11】候補探索の週は「いま表示中の週」を見る。
                  // ドラッグ処理は useEffect([]) で読み込み時の dates を握ったまま固定されるため、
                  // 最初に開いた週（実際の今週）の空きを探してしまっていた。常に最新を指す
                  // datesRef.current に差し替え（changes も同様に saveRef 経由で最新を見る）。
                  const curDates=datesRef.current||[];
                  const abNow2=abWeekNowRef.current;
                  const abOk2=b=>!b.altWeek||!abNow2||b.altWeek===abNow2; // A/B週で実際に表示されるbaseのみ対象
                  // 日課パターン解決（saveRefから常に最新を参照）
                  // 例: 月曜6限に「火曜3限」を割り当てている日は、そのスロットの中身・空き判定は火曜3限で行う
                  const patFor=date=>(saveRef.current?.dayPatterns||[]).find(dp=>dp.date===date);
                  const patDayOf=(date,p)=>{const pt=patFor(date);return pt?.periods?.[String(p)]?.day||pt?.useDay||dowOf(date);};
                  const patPerOf=(date,p)=>{const pt=patFor(date);const pp=pt?.periods?.[String(p)]?.period;return pp!=null?pp:p;};
                  curDates.forEach(dt=>{
                    const dow=dowOf(dt);if(!dow)return;
                    ALLP.forEach(p=>{
                      // 日課パターンの割り当てがあるスロットはマッピング先（patD/patP）で判定する
                      const patD=patDayOf(dt,p),patP=patPerOf(dt,p);
                      // 学校の使用時限設定: パターン割り当てがあればマッピング先の曜日・時限で判定
                      // → 月曜6限が未使用でも「火曜3限を入れる」設定がある日は候補に出る
                      if(ssCfg&&!((ssCfg[patD]||[]).includes(patP)))return;
                      if(dt===tgt.dc.date&&p===tgt.dc.period)return;
                      if(dt===(e.date||'')&&p===e.period)return;
                      // 重複相手の現在スロット（base entry は date を持たないため day で判定）も除外
                      if(!e.date&&patD===e.day&&patP===e.period)return;
                      // changesとbaseの両方で学級・先生が空いているか確認
                      const chgCidsAtSlot=new Set((saveRef.current?.changes||changes).filter(c=>c.date===dt&&c.period===p&&!c._removed&&!c.isBlocked&&!excludeIds.has(c.id)).flatMap(c=>c.classIds||[]));
                      // このスロットで何らかの変更（_removed=移動で消えた も含む）が触れている学級
                      // → 基本時間割エントリが実際には表示されていない（移動済み・置換済み）ため空きとみなす
                      const overriddenCidsAtSlot=new Set((saveRef.current?.changes||changes).filter(c=>c.date===dt&&c.period===p&&!excludeIds.has(c.id)).flatMap(c=>c.classIds||[]));
                      const baseCidsAtSlot=new Set(base.filter(b=>b.day===patD&&b.period===patP&&!b.isBlocked&&!excludeIds.has(b.id)&&abOk2(b)&&!(b.classIds||[]).some(cid=>overriddenCidsAtSlot.has(cid))).flatMap(b=>b.classIds||[]));
                      // ── 移動元スロットでは主役の学級・先生を占有から差し引く（IDズレに強い穴あけ）──
                      // 主役が抜けるとそのスロットは主役の学級ぶん空くため、ここでは占有とみなさない。
                      const isSrcSlot=(dt===src.dc.date&&p===src.dc.period);
                      if(isSrcSlot){
                        (src.entry.classIds||[]).forEach(c=>{chgCidsAtSlot.delete(c);baseCidsAtSlot.delete(c);overriddenCidsAtSlot.delete(c);});
                      }
                      const srcMainTids=new Set(isSrcSlot?(src.entry.teacherIds||[]):[]);
                      const classOk=![...eCids].some(cid=>chgCidsAtSlot.has(cid)||baseCidsAtSlot.has(cid));
                      const teacherOk=![...eTids].some(tid=>{
                        // 移動元スロットでは主役の先生は抜けるので占有から除外
                        if(srcMainTids.has(tid))return false;
                        // changes で既に担当している授業がある
                        if((saveRef.current?.changes||changes).some(c=>c.date===dt&&c.period===p&&(c.teacherIds||[]).includes(tid)&&!c._removed&&!c.isBlocked&&!excludeIds.has(c.id)))return true;
                        // base で別の授業を持っている（changesで上書き／移動済みでないもの・当該A/B週に表示されるもの）
                        if(base.some(b=>b.day===patD&&b.period===patP&&(b.teacherIds||[]).includes(tid)&&!b.isBlocked&&!excludeIds.has(b.id)&&abOk2(b)&&!(b.classIds||[]).some(cid=>overriddenCidsAtSlot.has(cid))&&!(isSrcSlot&&(b.teacherIds||[]).every(t=>srcMainTids.has(t))&&(b.classIds||[]).every(c=>(src.entry.classIds||[]).includes(c)))))return true;
                        // 不在設定チェック（先生の不在は実際の曜日・時限で判定）
                        const t=currentTeachersSnap.find(x=>x.id===tid);
                        return t&&!isSlotAvailable(t,dow,p,dt,teacherDateOverrides);
                      });
                      if(classOk&&teacherOk)slots.push({date:dt,day:dow,period:p});
                    });
                  });
                }
                // ── 玉突き候補（2手・通常モードのみ）──
                // 直接は空いていないが、塞いでいる駒を1つどかせば空くスロットを探す
                let chainCandidates=[];
                if(!dateModeRef.current){
                  const __b2=saveRef.current?.base||base;
                  const abNow3=abWeekNowRef.current;
                  const abOk3=b=>!b.altWeek||!abNow3||b.altWeek===abNow3;
                  const dateOvBad=(tids,d,p)=>[...tids].some(tid=>teacherDateOverrides&&Object.entries(teacherDateOverrides).some(([dt,ov])=>ov[tid]&&dowOf(dt)===d&&ov[tid][p]===false));
                  const directSet=new Set(slots.map(s=>`${s.day}-${s.period}`));
                  (ALLD||[]).forEach(d=>{
                    ALLP.forEach(p=>{
                      if(chainCandidates.length>=30)return; // 1枠=最大1候補なので30で全枠カバー
                      if(!slotUsable(d,p))return; // 学校として使っていない時限は除外
                      if(directSet.has(`${d}-${p}`))return;
                      if(d===(e.day||tgt.dc.day)&&p===e.period)return;
                      if(d===tgt.dc.day&&p===tgt.dc.period)return;
                      // eの先生がこの枠で会議・不在なら不可（どかしようがない）
                      if(hasSlotConflict.current([...eTids],d,p))return;
                      if(dateOvBad(eTids,d,p))return;
                      // この枠でeと衝突する駒（学級または先生の重なり）を収集
                      const blockers=__b2.filter(b=>b.day===d&&b.period===p&&!b.isBlocked&&!excludeIds.has(b.id)&&!benchIds.has(b.id)&&abOk3(b)
                        &&((b.classIds||[]).some(cid=>eCids.has(cid))||(b.teacherIds||[]).some(tid=>eTids.has(tid))));
                      if(blockers.length!==1)return; // 塞いでいる駒が1つだけの場合のみ
                      const c=blockers[0];
                      if(c.altWeek||c.linkGroup)return; // A/B週・連動コマはどかさない（安全のため）
                      if(sameAsSrc(c))return; // 主役と同一内容の駒はどかしても無意味
                      // 塞いでいる理由（この駒と同じ学級か、同じ先生か）
                      const reason=(c.classIds||[]).some(cid=>eCids.has(cid))?'class':'teacher';
                      // cのどかし先: cのクラス・先生が空いている枠（e・src・cは移動済み扱い）
                      const cCids=new Set(c.classIds||[]);
                      const cTids=new Set(c.teacherIds||[]);
                      const exclude2=new Set([...excludeIds,c.id]);
                      // 逃がし先は代表1件（1枠＝候補1件にして全曜日のカバーを保証）
                      const relocs=[];
                      for(const d2 of(ALLD||[])){
                        if(relocs.length>=1)break;
                        for(const p2 of ALLP){
                          if(relocs.length>=1)break;
                          if(!slotUsable(d2,p2))continue; // 学校として使っていない時限は除外
                          if(d2===d&&p2===p)continue;
                          if(d2===c.day&&p2===c.period)continue;
                          if(d2===tgt.dc.day&&p2===tgt.dc.period)continue;
                          if([...cCids].some(cid=>__b2.some(b=>b.day===d2&&b.period===p2&&(b.classIds||[]).includes(cid)&&!b.isBlocked&&!exclude2.has(b.id)&&!benchIds.has(b.id)&&abOk3(b))))continue;
                          if([...cTids].some(tid=>__b2.some(b=>b.day===d2&&b.period===p2&&(b.teacherIds||[]).includes(tid)&&!b.isBlocked&&!exclude2.has(b.id)&&!benchIds.has(b.id)&&abOk3(b))))continue;
                          if(hasSlotConflict.current([...cTids],d2,p2))continue;
                          if(dateOvBad(cTids,d2,p2))continue;
                          relocs.push({day:d2,period:p2});
                        }
                      }
                      relocs.forEach(r=>{
                        if(chainCandidates.length>=30)return;
                        chainCandidates.push({slot:{day:d,period:p},reason,
                          steps:[{entry:c,from:{day:d,period:p},to:r}]});
                      });
                    });
                  });
                }
                // ── 玉突き候補（連鎖・週間日課変更モード）──
                // 汎用の深さ制限つき連鎖探索。空いていない枠でも「塞ぐ駒が1つで、その駒を
                // さらにどかせる」場合は連鎖でたどる。深さは CHAIN_DEPTH で可変（現在3）。
                if(dateModeRef.current){
                  const CHAIN_DEPTH=3; // 変位の最大段数（e→c1→c2→c3 まで＝最大3手の玉突き）。
                  const curDates2=datesRef.current||[]; // 【v8_7_11】深掘り探索も今週を見る
                  const abNow4=abWeekNowRef.current;
                  const abOk4=b=>!b.altWeek||!abNow4||b.altWeek===abNow4;
                  // 基本モードと同様、最新の base/changes（saveRef）を参照する。
                  // クロージャに捕まえた古い base を使うと、既に消えた駒（孤児）を拾ってしまうため。
                  const baseE=saveRef.current?.base||base;
                  const changesE=saveRef.current?.changes||changes;
                  const patFor2=date=>(saveRef.current?.dayPatterns||[]).find(dp=>dp.date===date);
                  const patDayOf2=(date,pp)=>{const pt=patFor2(date);return pt?.periods?.[String(pp)]?.day||pt?.useDay||dowOf(date);};
                  const patPerOf2=(date,pp)=>{const pt=patFor2(date);const v=pt?.periods?.[String(pp)]?.period;return v!=null?v:pp;};
                  // 仮想位置 posMap(id->{date,period}) を考慮した占有エントリ取得
                  const occAtV=(dt,pp,posMap,exSet)=>{
                    const patD=patDayOf2(dt,pp),patP=patPerOf2(dt,pp);
                    const overridden=new Set(changesE.filter(c=>c.date===dt&&c.period===pp&&!exSet.has(c.id)&&!posMap[c.id]).flatMap(c=>c.classIds||[]));
                    const res=[];
                    for(const c of changesE){
                      if(c._removed||c.isBlocked||exSet.has(c.id))continue;
                      const v=posMap[c.id];const cd=v?v.date:c.date;const cp=v?v.period:c.period;
                      if(cd===dt&&cp===pp)res.push(c);
                    }
                    for(const b of baseE){
                      if(b.isBlocked||exSet.has(b.id)||!abOk4(b))continue;
                      const v=posMap[b.id];
                      if(v){if(v.date===dt&&v.period===pp)res.push(b);}
                      else{if(b.day===patD&&b.period===patP&&!(b.classIds||[]).some(cid=>overridden.has(cid)))res.push(b);}
                    }
                    return res;
                  };
                  const meetingsL=saveRef.current?.meetings||meetings||[];
                  // 先生が会議中の枠には置けない（会議は授業と別データで、占有判定に含まれないため明示チェック）
                  const tHasMeeting=(tid,dt,pp)=>meetingsL.some(m=>m.day===dowOf(dt)&&m.period===pp&&(m.teacherIds||[]).includes(tid));
                  const tOkAt=(piece,dt,pp)=>(piece.teacherIds||[]).every(tid=>{const t=currentTeachersSnap.find(x=>x.id===tid);if(t&&!isSlotAvailable(t,dowOf(dt),pp,dt,teacherDateOverrides))return false;if(tHasMeeting(tid,dt,pp))return false;return true;});
                  // piece を (dt,pp) に置けるか。置けるが塞ぐ駒が1つなら blockers に返す
                  const tryPlace=(piece,dt,pp,posMap)=>{
                    if(!tOkAt(piece,dt,pp))return null;
                    // 占有判定は piece 自身のみ除外（他の駒・主役・移動済みの駒は新位置で数える）
                    const occ=occAtV(dt,pp,posMap,new Set([piece.id]));
                    const blockers=occ.filter(b=>(b.classIds||[]).some(cid=>(piece.classIds||[]).includes(cid))||(b.teacherIds||[]).some(tid=>(piece.teacherIds||[]).includes(tid)));
                    return blockers;
                  };
                  // piece の移動先を探索（連鎖込み）。{slot, steps[]} の配列を返す
                  // moved: 既に動かした駒（=これ以上動かさない）。占有判定には影響しない
                  const place=(piece,posMap,moved,depth,cap)=>{
                    const out=[];
                    for(const dt of curDates2){
                      const dow=dowOf(dt);if(!dow)continue;
                      for(const pp of ALLP){
                        if(out.length>=cap)return out;
                        const patD=patDayOf2(dt,pp),patP=patPerOf2(dt,pp);
                        if(ssCfg&&!((ssCfg[patD]||[]).includes(patP)))continue;
                        // piece の現在地はスキップ（無意味な移動）
                        const cv=posMap[piece.id];
                        const curMatch=cv?(cv.date===dt&&cv.period===pp):(!piece.date?(patD===piece.day&&patP===piece.period):(dt===piece.date&&pp===piece.period));
                        if(curMatch)continue;
                        const blockers=tryPlace(piece,dt,pp,posMap);
                        if(blockers===null)continue;
                        if(blockers.length===0){
                          out.push({slot:{date:dt,day:dow,period:pp},steps:[]});
                        }else if(blockers.length===1&&depth>0){
                          const c=blockers[0];
                          if(c.altWeek||c.linkGroup||moved.has(c.id))continue;
                          if(sameAsSrc(c))continue; // 主役と同一内容の駒はどかしても無意味
                          const posMap2={...posMap,[piece.id]:{date:dt,period:pp}};
                          const sub=place(c,posMap2,new Set([...moved,c.id]),depth-1,2);
                          for(const sres of sub){
                            out.push({slot:{date:dt,day:dow,period:pp},
                              steps:[...sres.steps,{entry:c,from:{date:dt,day:dow,period:pp},to:sres.slot}]});
                            if(out.length>=cap)return out;
                          }
                        }
                      }
                    }
                    return out;
                  };
                  // 主役は月2限(tgtDc)を占有する駒として固定。動かさない（moved）。占有には数える。
                  const initPos={[src.entry.id]:{date:tgt.dc.date,period:tgt.dc.period}};
                  const initMoved=new Set([src.entry.id]);
                  const seen=new Set(slots.filter(s=>s.date).map(s=>`${s.date}-${s.period}`));
                  const eResults=place(e,initPos,initMoved,CHAIN_DEPTH,16);
                  // ── 連鎖の検算 ──
                  // 連鎖を全部適用した最終状態で、動いた駒すべてについて
                  //  元枠: 各学級が空かないか（合同は含む全学級）／ 移動先: 学級・先生が重複しないか
                  // を確認する。全部OKのときだけ「完全（★相当）」。
                  const classesL=saveRef.current?.classes||[];
                  const teachersL=saveRef.current?.teachers||[];
                  const cnm=cid=>(classesL.find(c=>c.id===cid)?.name)||cid;
                  const tnm=tid=>(teachersL.find(t=>t.id===tid)?.name)||tid;
                  const verifyChain=(rSlot,steps)=>{
                    const pm={[src.entry.id]:{date:tgt.dc.date,period:tgt.dc.period},
                              [e.id]:{date:rSlot.date,period:rSlot.period}};
                    steps.forEach(st=>{pm[st.entry.id]={date:st.to.date,period:st.to.period};});
                    const moved=[
                      {entry:src.entry,from:{date:src.dc.date,period:src.dc.period}},
                      {entry:e,from:{date:tgt.dc.date,period:tgt.dc.period},to:{date:rSlot.date,period:rSlot.period}},
                      ...steps.map(st=>({entry:st.entry,from:st.from,to:st.to})),
                    ];
                    const holes=new Set(),tConf=new Set(),cConf=new Set();
                    for(const m of moved){
                      // 元枠: 各学級がまだ授業を持っているか（埋まっているか）
                      if(m.from){
                        const fromOcc=occAtV(m.from.date,m.from.period,pm,new Set());
                        for(const cid of(m.entry.classIds||[])){
                          if(!fromOcc.some(o=>(o.classIds||[]).includes(cid)))holes.add(cnm(cid));
                        }
                      }
                      // 移動先: 学級・先生の重複（自分以外と衝突しないか）
                      if(m.to){
                        const toOcc=occAtV(m.to.date,m.to.period,pm,new Set([m.entry.id]));
                        for(const o of toOcc){
                          (m.entry.teacherIds||[]).filter(t=>(o.teacherIds||[]).includes(t)).forEach(t=>tConf.add(tnm(t)));
                          (m.entry.classIds||[]).filter(c=>(o.classIds||[]).includes(c)).forEach(c=>cConf.add(cnm(c)));
                        }
                        // 会議との重複（会議は占有判定に含まれないため明示チェック）
                        (m.entry.teacherIds||[]).forEach(t=>{if(tHasMeeting(t,m.to.date,m.to.period))tConf.add(tnm(t));});
                      }
                    }
                    return{ok:holes.size===0&&tConf.size===0&&cConf.size===0,
                           holes:[...holes],teacherConflicts:[...tConf],classConflicts:[...cConf]};
                  };
                  for(const r of eResults){
                    if(r.steps.length===0)continue; // 直接候補は別枠で表示済み
                    const key=`${r.slot.date}-${r.slot.period}`;
                    if(seen.has(key))continue; seen.add(key);
                    // e を塞いでいた駒（最後のステップの entry）から理由を判定
                    const blk=r.steps[r.steps.length-1].entry;
                    const reason=(blk.classIds||[]).some(cid=>eCids.has(cid))?'class':'teacher';
                    chainCandidates.push({slot:r.slot,steps:r.steps,reason,_verify:verifyChain(r.slot,r.steps)});
                    if(chainCandidates.length>=16)break;
                  }
                  // ── 深い連鎖探索(オンデマンド): パネルの「深く探す」ボタンで実行する ──
                  // 重い探索なので落下時には走らせず、関数として item に持たせる。各ブロッカーを
                  // 深さ3で連鎖させ、最大3件まで深い候補(reason:'deep')を返す。
                  const runDeep=()=>{
                    const out=[];
                    const seenD=new Set((slots||[]).filter(s=>s.date).map(s=>`${s.date}-${s.period}`));
                    (chainCandidates||[]).forEach(c=>{if(c.slot&&c.slot.date)seenD.add(`${c.slot.date}-${c.slot.period}`);});
                    const DEEP=3,SUBCAP=3;let addedDeep=0;
                    outerDeep:
                    for(const dt of curDates2){
                      const dow=dowOf(dt);if(!dow)continue;
                      for(const pp of ALLP){
                        const patD=patDayOf2(dt,pp),patP=patPerOf2(dt,pp);
                        if(ssCfg&&!((ssCfg[patD]||[]).includes(patP)))continue;
                        const ev=initPos[e.id];
                        const curMatch=ev?(ev.date===dt&&ev.period===pp):(!e.date?(patD===e.day&&patP===e.period):(dt===e.date&&pp===e.period));
                        if(curMatch)continue;
                        const blockers=tryPlace(e,dt,pp,initPos);
                        if(blockers===null||blockers.length===0||blockers.length>2)continue;
                        if(blockers.some(c=>c.altWeek||c.linkGroup||c.id===src.entry.id||sameAsSrc(c)))continue;
                        const key=`${dt}-${pp}`;
                        if(seenD.has(key))continue;
                        const posBase={...initPos,[e.id]:{date:dt,period:pp}};
                        const movedBase=new Set([src.entry.id,e.id,...blockers.map(b=>b.id)]);
                        const c1=blockers[0];
                        const r1=place(c1,posBase,new Set(movedBase),DEEP,SUBCAP);
                        let foundSteps=null;
                        for(const s1 of r1){
                          const steps1=[...s1.steps,{entry:c1,from:{date:dt,day:dow,period:pp},to:s1.slot}];
                          if(blockers.length===1){foundSteps=steps1;break;}
                          const pos2={...posBase};
                          steps1.forEach(st=>{pos2[st.entry.id]={date:st.to.date,period:st.to.period};});
                          const c2=blockers[1];
                          const r2=place(c2,pos2,new Set([...movedBase,...steps1.map(st=>st.entry.id)]),DEEP,SUBCAP);
                          if(r2.length>0){
                            const s2=r2[0];
                            const steps2=[...s2.steps,{entry:c2,from:{date:dt,day:dow,period:pp},to:s2.slot}];
                            foundSteps=[...steps1,...steps2];break;
                          }
                        }
                        if(!foundSteps)continue;
                        seenD.add(key);
                        out.push({slot:{date:dt,day:dow,period:pp},steps:foundSteps,reason:'deep',_verify:verifyChain({date:dt,period:pp},foundSteps)});
                        addedDeep++;
                        if(addedDeep>=3)break outerDeep;
                      }
                    }
                    return out;
                  };
                  return{...item,moveCandidates:slots.slice(0,8),chainCandidates,runDeep};
                }
                return{...item,moveCandidates:slots.slice(0,8),chainCandidates};
              });
              const savedSrcRef={entry:src.entry,dc:src.dc,srcHk:src.srcHk};
              const savedTgt={entry:tgtForMove,dc:tgt.dc};
              mainPlacedRef.current=false; // 主役の二重配置防止フラグをリセット

              // ── 主役が抜けて空く「学級の穴」を算出 ──
              // 移動元スロットに主役の学級の他の授業が無ければ、その学級はそこが空く。
              (()=>{
                try{
                  const srcCids=new Set(src.entry.classIds||[]);
                  const sd=src.dc;
                  const remainsAtSrc=(cid)=>{
                    if(dateModeRef.current){
                      // 週間: changes優先、無ければbase(パターン考慮は簡略にdow一致)
                      const dow=dowOf(sd.date||"");
                      const chg=(saveRef.current?.changes||changes).some(c=>c.date===sd.date&&c.period===sd.period&&!c._removed&&!c.isBlocked&&c.id!==src.entry.id&&(c.classIds||[]).includes(cid));
                      if(chg)return true;
                      return base.some(b=>!b.isBlocked&&!b._removed&&b.day===dow&&b.period===sd.period&&b.id!==src.entry.id&&(b.classIds||[]).includes(cid));
                    }
                    return base.some(b=>!b.isBlocked&&b.day===sd.day&&b.period===sd.period&&b.id!==src.entry.id&&(b.classIds||[]).includes(cid));
                  };
                  // 穴になる学級（主役の学級のうち、移動元に残らないもの）
                  const holeCids=[...srcCids].filter(cid=>!remainsAtSrc(cid));
                  if(holeCids.length===0)return;
                  const holeSlot=dateModeRef.current
                    ?{date:sd.date,day:dowOf(sd.date||""),period:sd.period}
                    :{day:sd.day,period:sd.period};
                  const sameSlot=(a,b)=>a&&b&&((a.date&&b.date)?(a.date===b.date):(a.day===b.day))&&a.period===b.period;
                  // 連鎖が穴を埋めるか＝いずれかのステップの着地点が穴スロット
                  const chainFillsHole=cc=>(cc.steps||[]).some(st=>sameSlot(st.to,holeSlot))?0:1;
                  // 各重複相手の候補を並べ替え:
                  //  直接候補 … 穴スロットを先頭（★）
                  //  連鎖候補 … 手数(steps)の少ない順を最優先、同手数なら穴を埋める連鎖を優先
                  moveCandidates.forEach(item=>{
                    const itemCids=new Set(item.entry.classIds||[]);
                    const fillsHole=holeCids.some(cid=>itemCids.has(cid));
                    item._holeSlot=fillsHole?holeSlot:null;
                    if(fillsHole){
                      (item.moveCandidates||[]).sort((a,b)=>{
                        const af=sameSlot(a,holeSlot)?0:1, bf=sameSlot(b,holeSlot)?0:1;
                        return af-bf;
                      });
                    }
                    // 連鎖の並び: ①完全（空き・重複なし）を最優先 → ②手数の少ない順 → ③穴を埋める方
                    (item.chainCandidates||[]).sort((a,b)=>{
                      const ao=a._verify?(a._verify.ok?0:1):0, bo=b._verify?(b._verify.ok?0:1):0;
                      if(ao!==bo)return ao-bo;            // まず「完全」なものを先頭へ
                      const sa=a.steps?.length||0, sb=b.steps?.length||0;
                      if(sa!==sb)return sa-sb;            // 次に手数が少ない方
                      return chainFillsHole(a)-chainFillsHole(b); // 同手数なら穴を埋める方
                    });
                  });
                }catch(_){}
              })();
              // トライアル開始前の状態を保存（やり直し/キャンセルで一発復元するため）
              trialSnapRef.current={
                base:JSON.parse(JSON.stringify(currentRef.current.base)),
                changes:JSON.parse(JSON.stringify(currentRef.current.changes)),
              };
              setConflictResolveModal({
                srcEntry:src.entry,srcDc:src.dc,
                tgtEntry:tgt.entry,tgtDc:tgt.dc,
                hasClassConflict,hasTeacherConflict,
                conflictItems:moveCandidates,
                dateMode:dateModeRef.current,
                dates:dateModeRef.current?dates:[],  // 週の日付リストを渡す
                onForce:()=>{
                  if(dateModeRef.current){
                    // 週間: 主役を移動先へ置くだけ（重複相手はそのまま＝重複を残して強制配置）
                    applyPlanAtomicRef.current([{entry:savedSrcRef.entry,from:savedSrcRef.dc,to:savedTgt.dc}]);
                  }else{
                    moveExecRef.current(savedSrcRef.entry,savedSrcRef.dc,savedTgt.entry,savedTgt.dc);
                  }
                  setMovedHks(new Set([savedSrcRef.srcHk,tgtHk].filter(Boolean)));
                  setLastEdited(tgtHk);
                },
                onMoveConflict:(conflictEntry,conflictDc,slot)=>{
                  // 重複相手を別スロットに移動してから元のドラッグを実行
                  const slotDc=dateModeRef.current?{date:slot.date,period:slot.period,day:slot.day}:{day:slot.day,period:slot.period};
                  moveExecRef.current(conflictEntry,conflictDc,null,slotDc);
                  setTimeout(()=>{
                    moveExecRef.current(savedSrcRef.entry,savedSrcRef.dc,savedTgt.entry,savedTgt.dc);
                    setMovedHks(new Set([savedSrcRef.srcHk,tgtHk].filter(Boolean)));
                    setLastEdited(tgtHk);
                  },50);
                },
                // トライアルパネル用: プレビュー適用（重複相手を退避し、続けて主役も移動）
                onPreviewConflict:(conflictEntry,conflictDc,slot)=>{
                  const slotDc=dateModeRef.current?{date:slot.date,period:slot.period,day:slot.day}:{day:slot.day,period:slot.period};
                  // 1) 重複相手を空きスロットへ退避
                  moveExecRef.current(conflictEntry,conflictDc,null,slotDc);
                  // 2) 続けて主役（元ドラッグ）を本来の移動先へ移動
                  setTimeout(()=>{
                    moveExecRef.current(savedSrcRef.entry,savedSrcRef.dc,savedTgt.entry,savedTgt.dc);
                    setMovedHks(new Set([savedSrcRef.srcHk,tgtHk].filter(Boolean)));
                    setLastEdited(tgtHk);
                  },50);
                  // 重複相手は引っ越したので相手ハイライトを消し、移動先のみ残す
                  if(trialHiRef.current)trialHiRef.current={...trialHiRef.current,conflicts:[]};
                },
                // トライアルパネル用: プレビューで既に主役も移動済みなので、確定では再移動しない
                onConfirmAfterPreview:(lines)=>{
                  setMovedHks(new Set([savedSrcRef.srcHk,tgtHk].filter(Boolean)));
                  setLastEdited(tgtHk);
                  if(lines&&lines.length)showMoveNotice('✅ 重複を解消して移動しました',lines);
                },
                // ── 複数重複対応: 重複相手を1件ずつ移動（主役はまだ動かさない）──
                onResolveConflictOnly:(conflictEntry,conflictDc,slot)=>{
                  const slotDc=dateModeRef.current?{date:slot.date,period:slot.period,day:slot.day}:{day:slot.day,period:slot.period};
                  moveExecRef.current(conflictEntry,conflictDc,null,slotDc);
                },
                // 玉突き（連鎖）で重複相手を1件解消：ステップを順に適用してから相手を移す。主役はまだ動かさない
                onResolveChainOnly:(conflictEntry,conflictDc,cc)=>{
                  const toDc=s=>s.date?{date:s.date,period:s.period,day:s.day}:{day:s.day,period:s.period};
                  const steps=cc.steps||[];
                  let i=0;
                  const applyNext=()=>{
                    if(i<steps.length){
                      const st=steps[i++];
                      moveExecRef.current(st.entry,toDc(st.from),null,toDc(st.to));
                      setTimeout(applyNext,40);
                    }else{
                      moveExecRef.current(conflictEntry,conflictDc,null,toDc(cc.slot));
                    }
                  };
                  applyNext();
                },
                // ── 週間モード: 全駒（主役＋解消済み相手＋玉突き各手）を一度に原子的適用 ──
                // resolvedList: [{entry, slot:{date,period,day}, chain?}]
                // 解消済みでない相手は移動先(tgt)に残るため、重複表示はそのまま維持される。
                onApplyResolved:(resolvedList)=>{
                  const tgtFrom={date:savedTgt.dc.date,period:savedTgt.dc.period};
                  const plan=[{entry:savedSrcRef.entry,from:savedSrcRef.dc,to:savedTgt.dc}];
                  (resolvedList||[]).forEach(r=>{
                    plan.push({entry:r.entry,from:tgtFrom,to:{date:r.slot.date,period:r.slot.period}});
                    if(r.chain&&(r.chain.steps||[]).length){
                      r.chain.steps.forEach(st=>{
                        plan.push({entry:st.entry,from:{date:st.from.date,period:st.from.period},to:{date:st.to.date,period:st.to.period}});
                      });
                    }
                  });
                  applyPlanAtomicRef.current(plan);
                  mainPlacedRef.current=true;
                  setMovedHks(new Set([savedSrcRef.srcHk,tgtHk].filter(Boolean)));
                  setLastEdited(tgtHk);
                },
                // 全ての重複相手を片付けた後、主役（元ドラッグ）を移動先へ配置する
                onPlaceMain:()=>{
                  if(mainPlacedRef.current)return; // 二重配置を防ぐ
                  mainPlacedRef.current=true;
                  if(dateModeRef.current){
                    // 週間: スワップせず主役のみ移動先へ。重複相手は残し、盤面に重複を見せる。
                    // （以降のユーザー操作で onApplyResolved が最終状態を原子的に再構築する）
                    applyPlanAtomicRef.current([{entry:savedSrcRef.entry,from:savedSrcRef.dc,to:savedTgt.dc}]);
                  }else{
                    moveExecRef.current(savedSrcRef.entry,savedSrcRef.dc,savedTgt.entry,savedTgt.dc);
                  }
                  setMovedHks(new Set([savedSrcRef.srcHk,tgtHk].filter(Boolean)));
                  setLastEdited(tgtHk);
                },
                // トライアルパネル用: 候補ホバー時に移動先セルを点滅
                onHoverCandidate:(item,slot)=>{
                  // 授業者一覧（1日表示）では候補の曜日へ表示を切り替え、点滅が見えるようにする
                  if(!dateModeRef.current&&slot.day){
                    const di=DAYS.indexOf(slot.day);
                    if(di>=0)setSelDi(di);
                  }
                  setCandidateTargetPulse({
                    date:slot.date||null,
                    day:slot.day||(slot.date?dowOf(slot.date):null),
                    period:slot.period,
                    tids:item.entry.teacherIds||[],
                    cids:item.entry.classIds||[],
                  });
                },
                onLeaveCandidate:()=>setCandidateTargetPulse(null),
                // トライアルパネル用: 連鎖カードホバー時に複数セルをまとめて点滅
                // cells=[{date,day,period,tids,cids,kind:'from'|'to'}] / null で消灯
                onPulseCells:(cells)=>setCandidateTargetPulse(cells&&cells.length?{cells}:null),
                // トライアルパネル用: スロット表記ホバー時に、その日のタブへ自動で切り替える
                // （授業者一覧／週間は1日ずつ表示のため、別日の駒を点滅させるには表示日を合わせる必要がある）
                onFocusSlot:(slot)=>{
                  if(!slot)return;
                  if(dateModeRef.current){
                    if(slot.date){const di=(datesRef.current||[]).indexOf(slot.date);if(di>=0)setSelDi(di);}
                  }else{
                    if(slot.day){const di=DAYS.indexOf(slot.day);if(di>=0)setSelDi(di);}
                  }
                },
              });
              // 常時ハイライト情報をセット: 移動元 / 移動先(主役) / 重複相手の現在地
              {
                const srcSlot=dateModeRef.current
                  ?{period:src.dc.period,date:src.dc.date,day:src.dc.date?dowOf(src.dc.date):src.dc.day,tids:src.entry.teacherIds||[],cids:src.entry.classIds||[]}
                  :{period:src.dc.period,day:src.dc.day,tids:src.entry.teacherIds||[],cids:src.entry.classIds||[]};
                const tgtSlot=dateModeRef.current
                  ?{period:tgt.dc.period,date:tgt.dc.date,day:dowOf(tgt.dc.date),tids:src.entry.teacherIds||[],cids:src.entry.classIds||[]}
                  :{period:tgt.dc.period,day:tgt.dc.day,tids:src.entry.teacherIds||[],cids:src.entry.classIds||[]};
                const confSlots=moveCandidates.map(it=>dateModeRef.current
                  ?{period:tgt.dc.period,date:tgt.dc.date,day:dowOf(tgt.dc.date),tids:it.entry.teacherIds||[],cids:it.entry.classIds||[]}
                  :{period:tgt.dc.period,day:tgt.dc.day,tids:it.entry.teacherIds||[],cids:it.entry.classIds||[]});
                trialHiRef.current={src:srcSlot,tgt:tgtSlot,conflicts:confSlots};
              }
              setDragVisual(null);hoverHkRef.current=null;setHoverHk(null);
              return;
            }
            // swap（tgtに駒がある）かつ同一学級コマが存在する場合は連鎖候補を探す
            const tgtEntry=tgt.entry;
            if(tgtEntry&&!tgtEntry.isBlocked&&!tgtEntry._removed){
              const sharedCids=(src.entry.classIds||[]).filter(cid=>(tgtEntry.classIds||[]).includes(cid));
              if(sharedCids.length>0){
                const srcDc=src.dc;const tgtDc=tgt.dc;
                const chainCands=computeChainCandidates.current(src.entry,src.dc,tgtEntry,tgt.dc);
                if(chainCands.length>0){
                  const savedSrcHk=src.srcHk;
                  // 【v8_7_17】直接交換でぶつかる（移動元 srcDc に tgtEntry を置くと先生/学級が重複する）かを判定。
                  //   ぶつからなければパネルを出さず即・直接交換。ぶつかる時だけ3コマ回転パネルを出す。
                  //   占有計算は v8_7_10 のターゲット側と同じ方式（slotChgCidsでベース上書きを除外）に揃える。
                  const directSwapConflicts=(()=>{
                    const _b=saveRef.current?.base||base,_c=saveRef.current?.changes||changes;
                    const bIds=new Set((benchRef.current||[]).filter(Boolean).map(x=>x.id));
                    const sDate=src.dc.date||null;
                    const sDow=dateModeRef.current?(sDate?dowOf(sDate):src.dc.day):src.dc.day;
                    const sPatDay=dateModeRef.current&&sDate?getPatDay(sDate,src.dc.period):sDow;
                    const sPatPer=dateModeRef.current&&sDate?getPatPeriod(sDate,src.dc.period):src.dc.period;
                    const sChgCids=dateModeRef.current?new Set(_c.filter(c=>c.date===sDate&&c.period===src.dc.period&&!c._removed).flatMap(c=>c.classIds||[])):new Set();
                    const baseAt=_b.filter(e=>e.day===sPatDay&&e.period===sPatPer&&!e.isBlocked&&!bIds.has(e.id)&&(!e.altWeek||!abWeekNowRef.current||e.altWeek===abWeekNowRef.current)&&![...(e.classIds||[])].some(cid=>sChgCids.has(cid)));
                    const chgAt=dateModeRef.current?_c.filter(c=>c.date===sDate&&c.period===src.dc.period&&!c._removed&&!c.isBlocked):[];
                    const atSrc=[...chgAt,...baseAt].filter((e,i,a)=>a.findIndex(x=>x.id===e.id)===i);
                    const tTids=new Set(tgtEntry.teacherIds||[]),tCids=new Set(tgtEntry.classIds||[]);
                    return atSrc.some(e=>e.id!==src.entry.id&&e.id!==tgtEntry.id&&((e.teacherIds||[]).some(t=>tTids.has(t))||(e.classIds||[]).some(c=>tCids.has(c))));
                  })();
                  if(directSwapConflicts){
                    setChainModal({
                      srcEntry:src.entry,srcDc:src.dc,
                      tgtEntry,tgtDc:tgt.dc,
                      candidates:chainCands,
                      execDirect:()=>{
                        moveExecRef.current(src.entry,src.dc,tgtEntry,tgt.dc);
                        setMovedHks(new Set([savedSrcHk,tgtHk].filter(Boolean)));
                      },
                    });
                    setDragVisual(null);hoverHkRef.current=null;setHoverHk(null);
                    return;
                  }
                  // 【v8_7_17】ぶつからない → パネルを出さず即・直接交換
                  moveExecRef.current(src.entry,src.dc,tgtEntry,tgt.dc);
                  setMovedHks(new Set([savedSrcHk,tgtHk].filter(Boolean)));
                  setDragVisual(null);hoverHkRef.current=null;setHoverHk(null);
                  return;
                }
              }
            }
            moveExecRef.current(src.entry,src.dc,tgtForMove,tgt.dc);
            // ── 玉突き提案（通常モード・空きセルへの単純移動のみ）──
            // 移動元のクラス枠が空くため、同一クラス内のずらしで埋める候補を提案する
            if(!dateModeRef.current
              &&src.dc.benchIdx==null&&tgt.dc.benchIdx==null
              &&!src.entry._isUnplaced&&!src.entry.isBlocked
              &&!src.entry.linkGroup&&!src.entry.altWeek
              &&src.dc.day&&src.dc.period&&tgt.dc.day&&tgt.dc.period
              &&!(src.dc.day===tgt.dc.day&&src.dc.period===tgt.dc.period)
              &&!tgt.entry){
              const fhChains=computeFillHoleChains.current(src.entry,src.dc,tgt.dc);
              if(fhChains.length>0){
                setFillHoleModal({
                  srcEntry:src.entry,
                  srcDc:{day:src.dc.day,period:src.dc.period},
                  tgtDc:{day:tgt.dc.day,period:tgt.dc.period},
                  chains:fhChains,
                });
              }
            }
          }
          setLastEdited(tgtHk);
          // 移動元・移動先の両方のセルを強調（移動元が空になった場合も視覚的に分かる）
          setMovedHks(new Set([src?.srcHk,tgtHk].filter(Boolean)));
        }
      }
      setDragVisual(null);hoverHkRef.current=null;setHoverHk(null);
    };
    const onCancel=()=>{
      dragRef.current=null;stopScroll();clearTabTimer();lastTabEl=null;
      setDragVisual(null);hoverHkRef.current=null;setHoverHk(null);
    };
    window.addEventListener('pointermove',onMove,{passive:true});
    window.addEventListener('pointerup',onUp);
    window.addEventListener('pointercancel',onCancel);
    return()=>{
      window.removeEventListener('pointermove',onMove);
      window.removeEventListener('pointerup',onUp);
      window.removeEventListener('pointercancel',onCancel);
    };
  },[]);

  const cols=dateMode
    ?dates.map((dt,i)=>({label:activeDays[i]+"\n"+fmtMD(dt),date:dt,di:i,isWeekend:isWeekendDay(activeDays[i])}))
    :DAYS.map((d,i)=>({label:d+"曜日",di:i,isWeekend:false}));

  const nConfl=conflicts.size;
  // 重複している箇所（学級×曜日×時限）を一覧化。同じセルに2駒重なっていても1箇所にまとめる。
  const conflictSlots=useMemo(()=>{
    const seen=new Set();const list=[];
    conflicts.forEach((info,id)=>{
      const ent=[...base,...changes].find(e=>e.id===id);
      const cid=ent&&(ent.classIds||[])[0];
      if(!cid)return;
      const day=ent.day||(ent.date?dowOf(ent.date):null);
      if(!day)return;
      const key=`${cid}|${day}|${ent.period}`;
      if(seen.has(key))return;
      seen.add(key);list.push({cid,day,period:ent.period});
    });
    return list;
  },[conflicts,base,changes]);
  const[conflictJumpIdx,setConflictJumpIdx]=useState(0);
  const pulseClearTimer=useRef(null);
  // 押すたびに、次の重複箇所へ。学級を切り替えて、その駒を数秒間点滅させる。
  const jumpToNextConflict=()=>{
    if(conflictSlots.length===0)return;
    const i=conflictJumpIdx%conflictSlots.length;
    const slot=conflictSlots[i];
    setView("class");
    setSelCls(slot.cid);
    setConflictJumpIdx((i+1)%conflictSlots.length);
    if(pulseClearTimer.current)clearTimeout(pulseClearTimer.current);
    // 学級切り替え後にセルが描画されてから、該当セルのhkを探して点滅させる
    setTimeout(()=>{
      const found=Object.entries(cellDataRef.current).find(([,c])=>c.dc&&c.dc.matchCid===slot.cid&&c.dc.period===slot.period&&c.dc.day===slot.day);
      if(found){
        setConflictPulseHks(new Set([found[0]]));
        pulseClearTimer.current=setTimeout(()=>setConflictPulseHks(new Set()),2600);
      }
    },150);
  };
  // ── 【v8_7_18】空き検出（A方式：基本時間割にコマがあるのに今週そのセルが空）──────
  //   移動・待機・欠課で「定位置が空」になったコマを拾う。押すと学級別へ切替＋緑点滅で巡回。
  //   通級・アップ等、基本コマ数が極端に少ない学級は自動で対象外（誤検出防止。フル学級の4割未満）。
  const emptySlots=useMemo(()=>{
    if(!dates||dates.length===0)return[];
    const baseCnt={};
    base.forEach(b=>{if(b.isBlocked)return;(b.classIds||[]).forEach(cid=>{baseCnt[cid]=(baseCnt[cid]||0)+1;});});
    const cnts=Object.values(baseCnt);if(cnts.length===0)return[];
    const threshold=Math.max(1,...cnts)*0.4; // フル学級の4割未満（通級・アップ等）は対象外
    const targetCids=new Set(Object.keys(baseCnt).filter(cid=>baseCnt[cid]>=threshold));
    const bIds=new Set((bench||[]).filter(Boolean).map(b=>b.id));
    const dateByDow={};dates.forEach(d=>{const w=dowOf(d);if(!(w in dateByDow))dateByDow[w]=d;});
    const seen=new Set();const list=[];
    base.forEach(b=>{
      if(b.isBlocked)return;
      if(b.altWeek&&abWeekNow&&b.altWeek!==abWeekNow)return; // 今週に出ないA/Bコマ
      const date=dateByDow[b.day];if(!date)return; // 今週にその曜日が無い（土日なし等）
      const benched=bIds.has(b.id);
      (b.classIds||[]).forEach(cid=>{
        if(!targetCids.has(cid))return;
        const key=`${cid}|${b.day}|${b.period}`;if(seen.has(key))return;
        const removedForCid=changes.some(c=>c.date===date&&c.period===b.period&&c._removed&&(c.classIds||[]).includes(cid));
        if(!benched&&!removedForCid)return; // このクラスの基本授業がそのまま出ている＝埋まっている
        const filled=changes.some(c=>c.date===date&&c.period===b.period&&!c._removed&&!c.isBlocked&&(c.classIds||[]).includes(cid));
        if(filled)return; // 変更で何か入っている＝埋まっている
        seen.add(key);list.push({cid,day:b.day,period:b.period});
      });
    });
    return list;
  },[base,changes,dates,abWeekNow,bench]);
  const[emptyJumpIdx,setEmptyJumpIdx]=useState(0);
  const emptyPulseTimer=useRef(null);
  // 押すたびに、次の空きへ。学級別へ切り替え、その空きセルを緑で数秒点滅。
  const jumpToNextEmpty=()=>{
    if(emptySlots.length===0)return;
    const i=emptyJumpIdx%emptySlots.length;
    const slot=emptySlots[i];
    setView("class");
    setSelCls(slot.cid);
    setEmptyJumpIdx((i+1)%emptySlots.length);
    const date=dateMode?(dates.find(d=>dowOf(d)===slot.day)||null):null;
    if(emptyPulseTimer.current)clearTimeout(emptyPulseTimer.current);
    setTimeout(()=>{
      setCandidateTargetPulse({date,day:slot.day,period:slot.period,cids:[slot.cid],tids:[]});
      emptyPulseTimer.current=setTimeout(()=>setCandidateTargetPulse(null),2600);
    },150);
  };
  const wkChg=changes.filter(c=>dates.includes(c.date)).length;

  const CellTD=({entry,conflict,onClick,hk,dc,baseEntry,periodPatternPicker,setPeriodPatternPicker,dayPatterns,setPeriodPat,clearPeriodPat,closeModal,isConflictPulse})=>{
    cellDataRef.current[hk]={entry,dc,onClick};
    const isBlk=entry?.isBlocked;
    const isDragSrc=dragVisual?.srcHk===hk;
    const isDragHov=hoverHk===hk&&!!dragVisual&&!isDragSrc;
    const isDragging=!!dragVisual;
    const showPicker=blockPicker?.hk===hk;
    const showPatPicker=periodPatternPicker?.hk===hk;
    const da=dragAnalysis?.[hk];
    const isLastEdited=lastEdited===hk;
    const isRecentMoved=(entry?.id!=null&&movedIds.has(entry.id))||movedHks.has(hk);
    const isPat=!!entry?._pat;
    const origBase=isBlk&&dc.day&&dc.matchCid
      ?base.find(b=>b.day===dc.day&&b.period===dc.period&&(b.classIds||[]).includes(dc.matchCid))
      :(baseEntry||null);
    // 🔗 連動相手の事前計算
    const linkPartners=entry?.linkGroup
      ?base.filter(e=>e.linkGroup===entry.linkGroup&&e.id!==entry.id)
      :[];
    const linkPartnerText=linkPartners.map(e=>(e.classIds||[]).map(c=>cn(c)).join("・")).join(" / ");
    const isLinkBroken=entry?.linkGroup?brokenLinkGroups.has(entry.linkGroup):false;
    // トライアルパネルで候補ホバー中、このセルが移動先かどうか
    const _cellDay=dateMode?dowOf(dc.date||""):dc.day;
    const isTargetPulse=candidateTargetPulse&&dc.period===candidateTargetPulse.period
      &&(dateMode?dc.date===candidateTargetPulse.date:(dc.day||_cellDay)===candidateTargetPulse.day)
      &&((dc.matchTid&&(candidateTargetPulse.tids||[]).includes(dc.matchTid))
        ||(dc.matchCid&&(candidateTargetPulse.cids||[]).includes(dc.matchCid)));

    return(
      <td data-hk={hk}
        data-sp={dc.period} data-sd={dc.date||""} data-sday={dc.day||""} data-stid={dc.matchTid||""} data-scid={dc.matchCid||""}
        onPointerDown={e=>{
          if(e.button!==0||blockPicker)return;
          if(isBlk){
            if(!origBase)return;
            e.preventDefault();
            dragRef.current={entry:{...origBase,_keepBlocked:true},dc,onClick,srcHk:hk,startX:e.clientX,startY:e.clientY,moved:false};
            return;
          }
          if(!entry){
            // 空きセルはクリックでモーダルを開く
            e.preventDefault();
            dragRef.current={entry:null,dc,onClick,srcHk:hk,startX:e.clientX,startY:e.clientY,moved:false};
            return;
          }
          e.preventDefault();
          dragRef.current={entry,dc,onClick,srcHk:hk,startX:e.clientX,startY:e.clientY,moved:false};
        }}
        onClick={e=>{
          if(isBlk){e.stopPropagation();onClick?.();}
        }}
        onMouseEnter={()=>!isDragging&&setHov(hk)}
        onMouseLeave={()=>setHov(null)}
        className={isTargetPulse?"candidate-target-pulse":isConflictPulse?"conflict-pulse":undefined} style={{padding:0,minWidth:90,height:68,verticalAlign:"top",
          opacity:isDragSrc?0.35:isDragging&&da?.type==="blocked"?0.5:1,
          outline:isConflictPulse?"none":isDragHov?(da?.type==="conflict"?"3px solid #EF4444":da?.type==="blocked"?"3px solid #9CA3AF":da?.type==="linkwarn"?"3px solid #F59E0B":da?.type==="linkswap"?"3px solid #06B6D4":"3px solid #22C55E"):isRecentMoved?"4px solid #10B981":conflict?"3px solid #EF4444":isLastEdited?"3px solid #6366F1":"none",
          outlineOffset:"-2px",
          border:conflict?"2px solid #EF4444":"1px solid #E2E8F0",
          borderLeft:isBlk?"3px solid #6B7280":entry?._ch?`3px solid ${entry.isSubst?"#EF4444":"#F59E0B"}`:"1px solid #E2E8F0",
          background:isDragging&&da?(
            da.type==="src"?"#BFDBFE":da.type==="empty"?"#DCFCE7":
            da.type==="swap"?"#FEF9C3":da.type==="chain"?"#F5F3FF":da.type==="conflict"?"#FEE2E2":da.type==="linkwarn"?"#FEF3C7":da.type==="linkswap"?"#ECFEFF":"#F3F4F6"
          ):(isBlk?gc(origBase?.subject||"")+"cc":entry?gc(entry.subject):"#FAFBFC"),
          cursor:entry&&!isBlk?"grab":"default",userSelect:"none",
          transition:isDragging?"background 0.08s":"all 0.12s",
          position:"relative"}}>
        {isLastEdited&&!isDragging&&<div style={{position:"absolute",top:2,left:2,fontSize:9,color:"#6366F1",fontWeight:700,zIndex:5,lineHeight:1}}>✎</div>}
        {conflict&&!isDragging&&<div title="重複しています" style={{position:"absolute",top:2,right:2,fontSize:10,fontWeight:800,color:"#DC2626",zIndex:6,lineHeight:1,background:"rgba(255,255,255,0.9)",borderRadius:3,padding:"1px 2px"}}>⚠</div>}
        <div style={{padding:"4px 5px",height:"100%",boxSizing:"border-box",position:"relative"}}>
        {isDragging&&da&&da.type!=="src"&&(
          <div style={{fontSize:9,fontWeight:700,marginBottom:1,
            color:da.type==="conflict"?"#DC2626":da.type==="empty"?"#16A34A":da.type==="swap"?"#92400E":da.type==="chain"?"#6D28D9":da.type==="linkwarn"?"#B45309":da.type==="linkswap"?"#0E7490":"#9CA3AF"}}>
            {da.type==="empty"?"✓ 空き":da.type==="swap"?`⇄ ${da.swapSubject}`:da.type==="chain"?`🔄 ${da.chainSubject||""}`:da.type==="conflict"?(da.unavailTids?.length>0?`🚫 不在`:da.conflictClasses?.length>0?`⚠ ${da.conflictClasses.map(c=>cn(c)).join("・")}重複`:"⚠ 先生重複"):da.type==="linkwarn"?`🔗⚠ ${da.linkNames}`:da.type==="linkswap"?`🔗↩ ${da.blockerNames}`:"🚫"}
          </div>
        )}
        {isDragHov&&da&&(
          <div style={{position:"absolute",bottom:"calc(100% + 4px)",left:"50%",transform:"translateX(-50%)",
            background:da.type==="conflict"?"#7F1D1D":da.type==="linkwarn"?"#92400E":da.type==="linkswap"?"#0E7490":da.type==="empty"?"#14532D":"#1E3A5F",
            color:"white",borderRadius:6,padding:"5px 10px",fontSize:11,whiteSpace:"nowrap",
            zIndex:200,boxShadow:"0 4px 12px rgba(0,0,0,0.25)",pointerEvents:"none"}}>
            {da.type==="empty"&&"✓ ここへ移動（空きコマ）"}
            {da.type==="swap"&&`⇄ ${da.swapSubject}（${(da.swapClasses||[]).map(c=>cn(c)).join("・")}）と入れ替え`}{da.type==="chain"&&`🔄 ${da.chainSubject} と3コマ回転候補`}
            {da.type==="conflict"&&(da.unavailTids?.length>0?`🚫 ${da.unavailTids.map(tid=>tn(tid)).join("・")}先生はこの時限に不在です`:da.conflictClasses?.length>0?`⚠ ${da.conflictClasses.map(c=>cn(c)).join("・")}が重複します`:"⚠ 先生が重複します")}
            {da.type==="blocked"&&"🚫 空きコマには移動できません"}
            {da.type==="linkwarn"&&`🔗⚠ 連動中の「${da.linkNames}」の移動先も塞がっています → ドロップするとリンクが外れます`}{da.type==="linkswap"&&`🔗↩ ${da.blockerNames}を${da.srcDay}曜${da.srcPeriod}限に退かして連動移動できます`}
          </div>
        )}
        {dateMode&&!isDragging&&(
          <div style={{position:"absolute",top:2,right:2,zIndex:10,display:"flex",gap:2}}
            onPointerDown={e=>{e.stopPropagation();e.preventDefault();}}
            onClick={e=>e.stopPropagation()}>
            {/* 🚫 空き設定 / ✏️ 理由変更（空き時） */}
            <div
              onClick={e=>{
                e.stopPropagation();
                const cids=dc.matchCid?[dc.matchCid]
                  :(entry?.classIds?.length>0?entry.classIds:[]);
                const tids=dc.matchTid?[dc.matchTid]:(entry?.teacherIds||[]);
                const rect=e.currentTarget.getBoundingClientRect();
                setBlockPicker({hk,date:dc.date,period:dc.period,classIds:cids,teacherIds:tids,
                  isClassView:!!dc.matchCid,
                  x:rect.right+4,y:rect.top});
              }}
              style={{background:isBlk?"#6B7280":"#374151",color:"white",borderRadius:4,padding:"1px 5px",fontSize:10,cursor:"pointer",lineHeight:"18px",
                opacity:isBlk?0.85:hov===hk?1:0.2,
                transition:"opacity 0.15s"}}>
              {isBlk?"✏️":"🚫"}
            </div>
          </div>
        )}
        {isDragSrc&&<div style={{fontSize:9,color:"#1D4ED8",fontWeight:700,textAlign:"center",marginBottom:1}}>✦ ドラッグ中</div>}
        {isBlk?(
          <div style={{fontSize:10,lineHeight:1.35}}>
            {origBase?(
              <div style={{opacity:0.45,marginBottom:2}}>
                <div style={{fontWeight:700,fontSize:13,color:"#1E293B",textDecoration:"line-through"}}>{origBase.subject}</div>
                <div style={{color:"#64748B",fontSize:10,textDecoration:"line-through"}}>{(origBase.teacherIds||[]).map(t=>tn(t)).join("・")}先生</div>
              </div>
            ):<div style={{height:8}}/>}
            <div style={{display:"inline-flex",alignItems:"center",gap:3,background:"rgba(55,65,81,0.88)",color:"white",borderRadius:4,padding:"1px 6px",fontSize:10,fontWeight:700}}>
              🚫 {entry.note||"空き"}
            </div>
          </div>
        ):entry?(
          <div style={{fontSize:10,lineHeight:1.35}}>
            {entry._ch&&<div style={{display:"inline-block",marginBottom:2,background:entry.isSubst?"#FEE2E2":"#FEF3C7",color:entry.isSubst?"#DC2626":"#B45309",fontSize:9,padding:"0 4px",borderRadius:3,fontWeight:700,border:`1px solid ${entry.isSubst?"#FECACA":"#FDE68A"}`}}>{entry.isSubst?"補欠":"変更"}</div>}
            {isPat&&!entry._ch&&<div
              onPointerDown={e=>{e.stopPropagation();e.preventDefault();}}
              onClick={e=>{e.stopPropagation();setBatchModal("pattern");}}
              style={{display:"inline-block",marginBottom:2,background:"#EDE9FE",color:"#6D28D9",fontSize:9,padding:"0 4px",borderRadius:3,fontWeight:700,border:"1px solid #DDD6FE",cursor:"pointer"}}>
              📅{entry._patDay}{entry._patPeriod}限
            </div>}
            <div style={{fontWeight:700,fontSize:13,color:"#1E293B",display:"flex",alignItems:"center",gap:3}}>
              {entry.subject}
              {entry.altWeek&&<span style={{fontSize:8,fontWeight:700,padding:"0 3px",borderRadius:2,
                background:entry.altWeek==="A"?"#DBEAFE":"#FEF3C7",
                color:entry.altWeek==="A"?"#1D4ED8":"#B45309",
                border:`1px solid ${entry.altWeek==="A"?"#93C5FD":"#FCD34D"}`}}>
                {entry.altWeek}週
              </span>}
            </div>
            <div style={{color:"#64748B"}}>{(entry.teacherIds||[]).map(t=>tn(t)).join("・")}先生</div>
            {(entry.classIds||[]).length>1&&<div style={{color:"#6366F1",fontSize:9,fontWeight:700}}>合同:{(entry.classIds||[]).map(c=>cn(c)).join("・")}</div>}
            {(entry.teacherIds||[]).length>1&&<div style={{color:"#0891B2",fontSize:9,fontWeight:700}}>TT</div>}
            {entry.note&&<div style={{color:"#9CA3AF",fontSize:9,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",maxWidth:82}}>📝{entry.note}</div>}
            {entry.linkGroup&&(
              <div style={{color:isLinkBroken?"#F59E0B":"#3B82F6",fontSize:9,fontWeight:700,cursor:"default",
                overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}
                title={`連動: ${linkPartnerText||"（なし）"}${isLinkBroken?" ⚠️ 時限がずれています":""}`}>
                {isLinkBroken?"🔗⚠":"🔗"}{linkPartnerText&&<span style={{fontWeight:400,marginLeft:2,fontSize:8}}>{linkPartnerText}</span>}
              </div>
            )}
            {conflict&&<ConflictDetail id={entry?.id} conflicts={conflicts} tn={tn} cn={cn} dc={dc} dowOf={dowOf} dateMode={dateMode}/>}
          </div>
        ):<div style={{color:isDragHov?"#3B82F6":"#CBD5E1",textAlign:"center",paddingTop:isDragHov?10:20,fontSize:isDragHov?13:16}}>
            {isDragHov?"↓":"＋"}
          </div>}
        </div>
      </td>
    );
  };

  const MultiCell=({entries,conflict,onClick,hk,dc,periodPatternPicker,setPeriodPatternPicker,dayPatterns,setPeriodPat,clearPeriodPat,closeModal,meetingCellMap,isConflictPulse})=>{
    cellDataRef.current[hk]={entry:entries[0]||null,dc,onClick};
    const first=entries[0];
    const isDragSrc=dragVisual?.srcHk===hk;
    const isDragHov=hoverHk===hk&&!!dragVisual&&!isDragSrc;
    const isDragging=!!dragVisual;
    const isBlk=first?.isBlocked&&entries.length>0;
    // 複数の isBlocked エントリを note でユニーク化（クラスごとに1エントリ作られるため重複除去）
    const blockedEntries=isBlk
      ?[...new Map(entries.filter(e=>e?.isBlocked).map(e=>[e.note||"空き",e])).values()]
      :[];
    const showPicker=blockPicker?.hk===hk;
    const da=dragAnalysis?.[hk];
    const isLastEdited=lastEdited===hk;
    const isRecentMoved=entries.some(e=>e?.id!=null&&movedIds.has(e.id))||movedHks.has(hk);
    const blockClassIds=dc.matchTid
      ? [...new Set(entries.flatMap(e=>e.classIds||[]))]
      : (dc.matchCid?[dc.matchCid]:[]);
    const blockTeacherIds=dc.matchTid?[dc.matchTid]
      : entries.length>0?[...new Set(entries.flatMap(e=>e.teacherIds||[]))]
      : [];
    const origBases=isBlk&&dc.day
      ?(()=>{
          // 出張で隠れる「元の授業」を集める。
          // (1) 日課パターンで対応する基本時間割の曜日・時限から拾う（gEsの授業表示と同じ対応にする）。
          //     例: 月6限が日課パターンで火4限を表示している場合、火4限の基本時間割を見る。
          // (2) さらに、週間日課変更で移動してきた授業（entries内の非isBlockedコマ）も対象にする。
          const oDay=(dateMode&&dc.date)?getPatDay(dc.date,dc.period):dc.day;
          const oPer=(dateMode&&dc.date)?getPatPeriod(dc.date,dc.period):dc.period;
          // 【v8_7_13】このスロットで「待機/別時限へ振替済み」の学級（自分宛 _removed）を集める。
          //   これらは元授業がもうここに無いので、見え消し（灰色表示）から外す。
          //   ＝「灰色あり＝まだここに居る／灰色なし＝振替済み」で区別できるようにする。
          const movedAwayCids=new Set(changes.filter(c=>{
            if(c.date!==dc.date||c.period!==dc.period||!c._removed)return false;
            const tIds=c.teacherIds||[];
            return dc.matchTid?(tIds.length===0||tIds.includes(dc.matchTid)):true;
          }).flatMap(c=>c.classIds||[]));
          // 【v8_7_15】このスロットに補欠(isSubst)が立っている学級は、見え消しの代わりに
          //   「補欠依頼済み」を出す（別の先生が受け持つので、実施される）。
          const substChgs=changes.filter(c=>!c._removed&&c.isSubst&&c.date===dc.date&&c.period===dc.period);
          const fromBase=base.filter(b=>b.day===oDay&&b.period===oPer&&(
            dc.matchTid?(b.teacherIds||[]).includes(dc.matchTid)
            :dc.matchCid&&(b.classIds||[]).includes(dc.matchCid)
          )&&!(b.classIds||[]).some(cid=>movedAwayCids.has(cid))).map(b=>{
            const sub=substChgs.find(c=>(c.classIds||[]).some(cid=>(b.classIds||[]).includes(cid)));
            return sub?{...b,_subst:true,_substTids:(sub.teacherIds||[]),_substNames:(sub.teacherIds||[]).map(t=>teachers.find(x=>x.id===t)?.name).filter(Boolean)}:b;
          });
          const fromChg=entries.filter(e=>e&&!e.isBlocked&&!e._removed&&e.subject&&(
            dc.matchTid?(e.teacherIds||[]).includes(dc.matchTid)
            :dc.matchCid&&(e.classIds||[]).includes(dc.matchCid)
          ));
          const seen=new Set(fromBase.map(b=>b.id));
          return[...fromBase,...fromChg.filter(e=>!seen.has(e.id))];
        })()
      :[];

    const cellDay2=dateMode?dowOf(dc.date||""):dc.day;
    const cellMeetings2=(meetingCellMap&&dc.matchTid)?meetingCellMap[`${dc.matchTid}|${cellDay2}|${dc.period}`]||[]:[];
    const hasMeetingOnly=cellMeetings2.length>0&&!first&&!isBlk;
    const meetingBorderColor=hasMeetingOnly?(MTG_TYPE_COLORS[cellMeetings2[0]?.type]||"#6D28D9"):null;
    const tchAbsent=(()=>{try{if(!dc.matchTid||!cellDay2)return false;const tch=teachers.find(t=>t.id===dc.matchTid);return tch?!isSlotAvailable(tch,cellDay2,dc.period,dc.date||null,teacherDateOverrides):false;}catch(_){return false;}})();
    // トライアルパネルで候補ホバー中、このセルが移動先かどうか
    const isTargetPulse=candidateTargetPulse&&dc.period===candidateTargetPulse.period
      &&(dateMode?dc.date===candidateTargetPulse.date:(dc.day||cellDay2)===candidateTargetPulse.day)
      &&((dc.matchTid&&(candidateTargetPulse.tids||[]).includes(dc.matchTid))
        ||(dc.matchCid&&(candidateTargetPulse.cids||[]).includes(dc.matchCid)));

    return(
      <td data-hk={hk}
        data-sp={dc.period} data-sd={dc.date||""} data-sday={dc.day||""} data-stid={dc.matchTid||""} data-scid={dc.matchCid||""}
        onPointerDown={e=>{
          if(e.button!==0||blockPicker||hasMeetingOnly)return;
          if(isBlk){
            // 出張・欠課セルでも元のbaseコマがあればドラッグ可能
            const baseEntry2=origBases[0];
            if(!baseEntry2)return;
            e.preventDefault();
            // _keepBlocked フラグで移動後も isBlocked エントリを残すことを示す
            dragRef.current={entry:{...baseEntry2,_keepBlocked:true},dc,onClick,srcHk:hk,startX:e.clientX,startY:e.clientY,moved:false};
            return;
          }
          if(!first){
            // 空きセルはクリックでモーダルを開く（授業者別ビューで新規授業を入れられるように）
            e.preventDefault();
            dragRef.current={entry:null,dc,onClick,srcHk:hk,startX:e.clientX,startY:e.clientY,moved:false};
            return;
          }
          e.preventDefault();
          dragRef.current={entry:first,dc,onClick,srcHk:hk,startX:e.clientX,startY:e.clientY,moved:false};
        }}
        onClick={e=>{
          if(isBlk){e.stopPropagation();onClick?.();}
        }}
        onMouseEnter={()=>!isDragging&&setHov(hk)}
        onMouseLeave={()=>setHov(null)}
        className={isTargetPulse?"candidate-target-pulse":isConflictPulse?"conflict-pulse":undefined} style={{padding:0,minWidth:90,height:68,verticalAlign:"top",
          opacity:isDragSrc?0.35:isDragging&&da?.type==="blocked"?0.5:1,
          outline:isDragHov?(da?.type==="conflict"?"3px solid #EF4444":da?.type==="blocked"?"3px solid #9CA3AF":da?.type==="linkwarn"?"3px solid #F59E0B":da?.type==="linkswap"?"3px solid #06B6D4":"3px solid #22C55E"):isRecentMoved?"4px solid #10B981":conflict?"3px solid #EF4444":isLastEdited?"3px solid #6366F1":"none",
          outlineOffset:"-2px",
          border:conflict?"2px solid #EF4444":"1px solid #E2E8F0",
          borderLeft:isBlk?"3px solid #9CA3AF":meetingBorderColor?`3px solid ${meetingBorderColor}`:first?._ch?`3px solid ${first.isSubst?"#EF4444":"#F59E0B"}`:"1px solid #E2E8F0",
          background:isDragging&&da?(
            da.type==="src"?"#BFDBFE":da.type==="empty"?"#DCFCE7":
            da.type==="swap"?"#FEF9C3":da.type==="chain"?"#F5F3FF":da.type==="conflict"?"#FEE2E2":da.type==="linkwarn"?"#FEF3C7":da.type==="linkswap"?"#ECFEFF":"#F3F4F6"
          ):(isBlk?gc(origBases[0]?.subject||"")+"cc":first?gc(first.subject):tchAbsent?"#F9FAFB":"#FAFBFC"),
          cursor:first&&!isBlk&&!tchAbsent?"grab":"default",userSelect:"none",
          transition:isDragging?"background 0.08s":"all 0.12s",position:"relative"}}>
        {isLastEdited&&!isDragging&&<div style={{position:"absolute",top:2,left:2,fontSize:9,color:"#6366F1",fontWeight:700,zIndex:5,lineHeight:1}}>✎</div>}
        {conflict&&!isDragging&&<div title="重複しています" style={{position:"absolute",top:2,right:2,fontSize:10,fontWeight:800,color:"#DC2626",zIndex:6,lineHeight:1,background:"rgba(255,255,255,0.9)",borderRadius:3,padding:"1px 2px"}}>⚠</div>}
        <div style={{padding:"4px 5px",height:"100%",boxSizing:"border-box",position:"relative"}}>
        {isDragging&&da&&da.type!=="src"&&(
          <div style={{fontSize:9,fontWeight:700,marginBottom:1,
            color:da.type==="conflict"?"#DC2626":da.type==="empty"?"#16A34A":da.type==="swap"?"#92400E":da.type==="chain"?"#6D28D9":da.type==="linkwarn"?"#B45309":da.type==="linkswap"?"#0E7490":"#9CA3AF"}}>
            {da.type==="empty"?"✓ 空き":da.type==="swap"?`⇄ ${da.swapSubject}`:da.type==="chain"?`🔄 ${da.chainSubject||""}`:da.type==="conflict"?(da.unavailTids?.length>0?`🚫 不在`:da.conflictClasses?.length>0?`⚠ ${da.conflictClasses.map(c=>cn(c)).join("・")}重複`:"⚠ 先生重複"):da.type==="linkwarn"?`🔗⚠ ${da.linkNames}`:da.type==="linkswap"?`🔗↩ ${da.blockerNames}`:"🚫"}
          </div>
        )}
        {isDragHov&&da&&(
          <div style={{position:"absolute",bottom:"calc(100% + 4px)",left:"50%",transform:"translateX(-50%)",
            background:da.type==="conflict"?"#7F1D1D":da.type==="linkwarn"?"#92400E":da.type==="linkswap"?"#0E7490":da.type==="empty"?"#14532D":"#1E3A5F",
            color:"white",borderRadius:6,padding:"5px 10px",fontSize:11,whiteSpace:"nowrap",
            zIndex:200,boxShadow:"0 4px 12px rgba(0,0,0,0.25)",pointerEvents:"none"}}>
            {da.type==="empty"&&"✓ ここへ移動（空きコマ）"}
            {da.type==="swap"&&`⇄ ${da.swapSubject}（${(da.swapClasses||[]).map(c=>cn(c)).join("・")}）と入れ替え`}{da.type==="chain"&&`🔄 ${da.chainSubject} と3コマ回転候補`}
            {da.type==="conflict"&&(da.unavailTids?.length>0?`🚫 ${da.unavailTids.map(tid=>tn(tid)).join("・")}先生はこの時限に不在です`:da.conflictClasses?.length>0?`⚠ ${da.conflictClasses.map(c=>cn(c)).join("・")}が重複します`:"⚠ 先生が重複します")}
            {da.type==="blocked"&&"🚫 空きコマには移動できません"}
            {da.type==="linkwarn"&&`🔗⚠ 連動中の「${da.linkNames}」の移動先も塞がっています → ドロップするとリンクが外れます`}{da.type==="linkswap"&&`🔗↩ ${da.blockerNames}を${da.srcDay}曜${da.srcPeriod}限に退かして連動移動できます`}
          </div>
        )}
        {dateMode&&!isDragging&&(
          <div style={{position:"absolute",top:2,right:2,zIndex:10,display:"flex",gap:2}}
            onPointerDown={e=>{e.stopPropagation();e.preventDefault();}}
            onClick={e=>e.stopPropagation()}>
            <div
              onClick={e=>{
                e.stopPropagation();
                const cids=blockClassIds.length>0?blockClassIds
                  :(dc.matchCid?[dc.matchCid]
                  :(dc.matchTid?teachers.find(t=>t.id===dc.matchTid)?.asgn.map(a=>a.c).filter((v,i,s)=>s.indexOf(v)===i)||[]
                  :(first?.classIds||[])));
                const rect=e.currentTarget.getBoundingClientRect();
                setBlockPicker({hk,date:dc.date,period:dc.period,classIds:cids,teacherIds:blockTeacherIds,
                  isClassView:!!dc.matchCid,
                  x:rect.right+4,y:rect.top});
              }}
              style={{background:isBlk?"#6B7280":"#374151",color:"white",borderRadius:4,padding:"1px 5px",fontSize:10,cursor:"pointer",lineHeight:"18px",
                opacity:isBlk?0.85:hov===hk?1:0.25,
                transition:"opacity 0.15s"}}>
              {isBlk?"✏️":"🚫"}
            </div>
          </div>
        )}
        {showPicker&&null}
        {isDragSrc&&<div style={{fontSize:9,color:"#1D4ED8",fontWeight:700,textAlign:"center",marginBottom:1}}>✦ ドラッグ中</div>}
        {isBlk?(
          <div style={{fontSize:10,lineHeight:1.3}}>
            {origBases.map((b,i)=>(
              b._subst?(
                // 【v8_7_15】補欠依頼済み：別の先生が受け持つので実施される＝見え消しにしない
                <div key={i} style={{marginBottom:1}}>
                  <span style={{background:"#FEE2E2",color:"#DC2626",fontSize:9,padding:"0 4px",borderRadius:3,fontWeight:700,marginRight:3,border:"1px solid #FECACA"}}>補欠依頼済み</span>
                  <span style={{fontWeight:700,color:"#1E293B"}}>{b.subject}</span>
                  <span style={{color:"#64748B",marginLeft:3}}>{(b.classIds||[]).map(c=>cn(c)).join("・")}</span>
                  {(b._substNames||[]).length>0&&<span data-hoverspec={JSON.stringify({date:dc.date,day:dowOf(dc.date||""),period:dc.period,tids:b._substTids||[],cids:[]})}
                    style={{color:"#DC2626",marginLeft:3,fontSize:9,cursor:"pointer",textDecoration:"underline dotted"}}>→{b._substNames.join("・")}先生</span>}
                </div>
              ):(
                <div key={i} style={{opacity:0.45,textDecoration:"line-through",marginBottom:1}}>
                  <span style={{fontWeight:700,color:"#1E293B"}}>{b.subject}</span>
                  <span style={{color:"#64748B",marginLeft:3}}>{(b.classIds||[]).map(c=>cn(c)).join("・")}</span>
                </div>
              )
            ))}
            {origBases.length===0&&<div style={{height:4}}/>}
            {blockedEntries.map((be,i)=>(
              <div key={i} style={{display:"inline-flex",alignItems:"center",gap:3,background:"rgba(55,65,81,0.88)",color:"white",borderRadius:4,padding:"1px 6px",fontSize:10,fontWeight:700,marginTop:2,marginRight:2}}>
                🚫 {be.note||"空き"}
              </div>
            ))}
          </div>
        ):(()=>{
          const cellDay=dateMode?dowOf(dc.date||""):dc.day;
          const cellMeetings=(meetingCellMap&&dc.matchTid)
            ?meetingCellMap[`${dc.matchTid}|${cellDay}|${dc.period}`]||[]
            :[];
          const renderMtgChips=()=>cellMeetings.map(m=>{
            const mc=MTG_TYPE_COLORS[m.type]||"#475569";
            return(
              <div key={m.id} style={{display:"flex",alignItems:"center",gap:3,
                background:mc,color:"white",borderRadius:4,
                padding:"2px 6px",fontSize:9,fontWeight:700,
                marginTop:2,lineHeight:1.3,overflow:"hidden"}}>
                <span>📋</span>
                <span style={{overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{m.name}</span>
              </div>
            );
          });
          if(entries.length>0) return(
            <div>
              {entries.map((e,i)=>(
                <div key={e.id||i}
                  onPointerDown={ev=>{
                    // 【v8_7_20】複数の駒が重なっているセルで、掴んだ駒を個別に選んで動かせるように。
                    //   行ごとに pointerdown を受け、その駒(e)をドラッグ対象にする（従来は常に先頭の駒だった）。
                    if(ev.button!==0||blockPicker||!e||e.isBlocked)return;
                    ev.preventDefault();ev.stopPropagation();
                    dragRef.current={entry:e,dc,onClick,srcHk:hk,startX:ev.clientX,startY:ev.clientY,moved:false};
                  }}
                  title={entries.length>1?"この駒をドラッグして移動できます":undefined}
                  style={{borderTop:i>0?"1px dashed #E2E8F0":"none",paddingTop:i>0?2:0,fontSize:10,lineHeight:1.3,
                    cursor:e&&!e.isBlocked?"grab":"default",
                    ...(entries.length>1?{position:"relative",background:"rgba(59,130,246,0.06)",border:"1px solid rgba(59,130,246,0.25)",borderRadius:3,padding:"2px 12px 2px 4px",marginBottom:2}:{})}}>
                  {entries.length>1&&<span title="ドラッグして移動" style={{position:"absolute",top:1,right:2,color:"#94A3B8",fontSize:10,lineHeight:1,cursor:"grab"}}>⠿</span>}
                  {e._ch&&<span style={{background:e.isSubst?"#FEE2E2":"#FEF3C7",color:e.isSubst?"#DC2626":"#B45309",fontSize:9,padding:"0 3px",borderRadius:2,fontWeight:700,marginRight:2}}>{e.isSubst?"補欠":"変更"}</span>}
                  <span style={{fontWeight:700,color:"#1E293B"}}>{e.subject}</span>
                  {e.altWeek&&!dateMode&&<span style={{fontSize:7,fontWeight:700,padding:"0 2px",borderRadius:2,marginLeft:2,
                    background:e.altWeek==="A"?"#DBEAFE":"#FEF3C7",
                    color:e.altWeek==="A"?"#1D4ED8":"#B45309"}}>
                    {e.altWeek}週
                  </span>}
                  {(e.linkGroup||resolveLinkGroup(e))&&(()=>{
                    const lg=e.linkGroup||resolveLinkGroup(e);
                    const ePartners=base.filter(b=>b.linkGroup===lg&&b.id!==e.id);
                    const ePartnerText=ePartners.map(b=>(b.classIds||[]).map(c=>cn(c)).join("・")).join(" / ");
                    const eBroken=brokenLinkGroups.has(lg);
                    return(
                      <div style={{color:eBroken?"#F59E0B":"#3B82F6",fontSize:9,fontWeight:700,
                        overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}
                        title={`連動: ${ePartnerText||"（なし）"}${eBroken?" ⚠️ 時限がずれています":""}`}>
                        {eBroken?"🔗⚠":"🔗"}{ePartnerText&&<span style={{fontWeight:400,marginLeft:2,fontSize:8}}>{ePartnerText}</span>}
                      </div>
                    );
                  })()}
                  <div style={{color:"#64748B"}}>{(e.classIds||[]).map(c=>cn(c)).join("・")}</div>
                  {(e.classIds||[]).length>1&&<div style={{color:"#6366F1",fontSize:9}}>合同</div>}
                </div>
              ))}
              {renderMtgChips()}
              {conflict&&<ConflictDetail id={entries[0]?.id} conflicts={conflicts} tn={tn} cn={cn} dc={dc} dowOf={dowOf} dateMode={dateMode}/>}
            </div>
          );
          if(cellMeetings.length>0) return(
            <div>{renderMtgChips()}</div>
          );
          return(
            <div style={{color:isDragHov?"#3B82F6":"#CBD5E1",textAlign:"center",paddingTop:isDragHov?10:20,fontSize:isDragHov?13:14}}>
              {isDragHov?"↓":"—"}
              {tchAbsent&&dateMode&&dc.date&&!isDragHov&&(
                <div style={{fontSize:8,color:"#3B82F6",cursor:"pointer",marginTop:4,textDecoration:"underline"}}
                  onPointerDown={e=>e.stopPropagation()}
                  onClick={e=>{e.stopPropagation();
                    setTeacherDateOverrides(p=>[...p,{teacherId:dc.matchTid,date:dc.date,period:dc.period}]);
                  }}>
                  この時限は出勤
                </div>
              )}
            </div>
          );
        })()}
        </div>
      </td>
    );
  };

  const openModal=(e,ctx)=>setModal({entry:e,...ctx});

  if(classParam&&dbLoaded) return(
    <StudentView
      schoolName={schoolName}
      classes={classes}
      teachers={teachers}
      base={base}
      changes={changes}
      isLocked={true}
      lockedClassId={classParam}
      publishedAt={publishedAt}
      onExit={null}
    />
  );

  if((modeParam==="teacher"||!isAdmin)&&dbLoaded) return(
    <TeacherView
      schoolName={schoolName}
      classes={classes}
      teachers={teachers}
      base={base}
      changes={changes}
      publishedAt={publishedAt}
      onExit={null}
      onLogout={onLogout}
    />
  );

  if(!dbLoaded) return(
    <div style={{minHeight:"100vh",background:"#F0F4F8",display:"flex",alignItems:"center",justifyContent:"center",fontFamily:"'Noto Sans JP',sans-serif"}}>
      <div style={{textAlign:"center",color:"#1E3A5F"}}>
        <div style={{fontSize:40,marginBottom:16}}>📚</div>
        <div style={{fontSize:16,fontWeight:700,marginBottom:8}}>時間割データを読み込んでいます...</div>
        <div style={{fontSize:12,color:"#64748B"}}>Supabaseに接続中</div>
      </div>
    </div>
  );

  if(studentMode) return(
    <StudentView
      schoolName={schoolName}
      classes={classes}
      teachers={teachers}
      base={base}
      changes={changes}
      isLocked={false}
      lockedClassId={null}
      onExit={()=>setStudentMode(false)}
    />
  );

  if(teacherMode) return(
    <TeacherView
      schoolName={schoolName}
      classes={classes}
      teachers={teachers}
      base={base}
      changes={changes}
      onExit={()=>setTeacherMode(false)}
    />
  );

  return(
    <div style={{minHeight:"100vh",background:"#F0F4F8",fontFamily:"'Noto Sans JP','Hiragino Sans',sans-serif",zoom:zoom,
      marginRight:(conflictResolveModal&&!panelMinimized)?408:0,transition:"margin-right 0.3s cubic-bezier(0.4,0,0.2,1)"}}>


      {/* ズームコントロール */}
      <div style={{position:"fixed",bottom:16,right:16,zIndex:9999,zoom:`${1/zoom}`,display:"flex",alignItems:"center",gap:6,background:"rgba(255,255,255,0.95)",border:"1.5px solid #CBD5E1",borderRadius:10,padding:"6px 12px",boxShadow:"0 4px 16px rgba(0,0,0,0.12)"}}>
        <button onClick={()=>setZoom(z=>Math.max(0.5,+(z-0.1).toFixed(1)))}
          style={{background:"none",border:"none",cursor:"pointer",fontSize:16,color:"#475569",lineHeight:1,padding:"0 2px"}}>－</button>
        <input type="range" min={50} max={150} step={5} value={Math.round(zoom*100)}
          onChange={e=>setZoom(Number(e.target.value)/100)}
          onWheel={e=>{e.preventDefault();setZoom(z=>Math.min(1.5,Math.max(0.5,+(z+(e.deltaY<0?0.05:-0.05)).toFixed(2))));}}
          style={{width:100,accentColor:"#1E3A5F",cursor:"pointer"}}/>
        <button onClick={()=>setZoom(z=>Math.min(1.5,+(z+0.1).toFixed(1)))}
          style={{background:"none",border:"none",cursor:"pointer",fontSize:16,color:"#475569",lineHeight:1,padding:"0 2px"}}>＋</button>
        <button onClick={()=>setZoom(1)}
          style={{background:zoom===1?"#1E3A5F":"#E2E8F0",color:zoom===1?"white":"#475569",border:"none",borderRadius:4,cursor:"pointer",fontSize:11,padding:"2px 8px",fontWeight:700,minWidth:36}}>
          {Math.round(zoom*100)}%
        </button>
        <div style={{width:1,height:20,background:"#CBD5E1",margin:"0 2px"}}/>
        <button onClick={()=>{
            if(!document.fullscreenElement){document.documentElement.requestFullscreen?.();}
            else{document.exitFullscreen?.();}
          }}
          title="全画面表示"
          style={{background:"none",border:"none",cursor:"pointer",fontSize:18,color:"#475569",lineHeight:1,padding:"0 2px"}}>
          {isFullscreen?"⊠":"⛶"}
        </button>
      </div>

      {/* ゴースト */}
      {dragVisual&&(
        <div style={{position:"fixed",left:dragVisual.x+14,top:dragVisual.y-18,
          background:"white",border:"2px solid #3B82F6",borderRadius:8,
          padding:"5px 12px",fontSize:12,fontWeight:700,color:"#1E293B",
          pointerEvents:"none",zIndex:9999,boxShadow:"0 6px 24px rgba(0,0,0,0.22)",
          opacity:0.92,whiteSpace:"nowrap"}}>
          ✦ {dragVisual.label}
        </div>
      )}

      {/* 🔗 連動移動の通知トースト */}
      {linkNotice&&(
        <div style={{position:"fixed",bottom:80,left:"50%",transform:"translateX(-50%)",
          background:linkNotice.type==="warn"?"#FEF3C7":"#ECFDF5",
          border:`1.5px solid ${linkNotice.type==="warn"?"#FDE68A":"#A7F3D0"}`,
          borderRadius:8,padding:"10px 20px",fontSize:13,fontWeight:700,
          color:linkNotice.type==="warn"?"#92400E":"#065F46",
          boxShadow:"0 4px 16px rgba(0,0,0,0.15)",zIndex:9998,
          whiteSpace:"nowrap",pointerEvents:"none"}}>
          {linkNotice.text}
        </div>
      )}

      {/* ── 移動サマリー通知（複数コマの移動内容）── */}
      {moveNotice&&(
        <div onClick={()=>{clearTimeout(moveNoticeTimerRef.current);setMoveNotice(null);}}
          style={{position:"fixed",bottom:80,left:"50%",transform:"translateX(-50%)",
          background:"#ECFDF5",border:"1.5px solid #A7F3D0",
          borderRadius:10,padding:"12px 20px",fontSize:12,
          color:"#065F46",boxShadow:"0 4px 16px rgba(0,0,0,0.18)",zIndex:9998,
          maxWidth:"90vw",cursor:"pointer"}}>
          <div style={{fontWeight:800,fontSize:13,marginBottom:6,display:"flex",alignItems:"center",gap:8}}>
            {moveNotice.title}
            <span style={{fontSize:10,color:"#6EE7B7",fontWeight:600}}>（クリックで閉じる）</span>
          </div>
          {moveNotice.lines.map((ln,i)=>(
            <div key={i} style={{fontWeight:600,lineHeight:1.7,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{ln}</div>
          ))}
        </div>
      )}

      {/* ── Header（1行目）── */}
      <div style={{background:"#1E3A5F",color:"white",padding:"0 12px",display:"flex",alignItems:"center",height:46,gap:8,overflowX:"auto",scrollbarWidth:"none",flexShrink:0}}>
        <span style={{fontSize:18,flexShrink:0}}>📚</span>
        <span style={{fontWeight:700,fontSize:14,whiteSpace:"nowrap",flexShrink:0,letterSpacing:"0.02em"}}>{schoolName} 時間割</span>
        <span style={{fontSize:10,fontWeight:600,color:"rgba(255,255,255,0.55)",whiteSpace:"nowrap",flexShrink:0,letterSpacing:"0.02em"}}>v{APP_VERSION}</span>
        {isDemo&&(
          <>
            <span style={{flexShrink:0,background:"#F59E0B",color:"#1E293B",fontWeight:800,fontSize:11,
              padding:"3px 9px",borderRadius:6,whiteSpace:"nowrap",letterSpacing:"0.03em"}}>
              体験版・保存されません
            </span>
            <button onClick={()=>{if(window.confirm("変更を破棄して初期状態に戻しますか？"))window.location.reload();}}
              style={{flexShrink:0,background:"rgba(255,255,255,0.15)",color:"white",border:"1px solid rgba(255,255,255,0.35)",
                fontWeight:700,fontSize:11,padding:"3px 9px",borderRadius:6,whiteSpace:"nowrap",cursor:"pointer"}}>
              ↻ 初期状態に戻す
            </button>
          </>
        )}
        <div style={{width:1,height:18,background:"rgba(255,255,255,0.25)",flexShrink:0,margin:"0 2px"}}/>

        {/* ステータス */}
        {dragVisual
          ?<span style={{background:"#3B82F6",borderRadius:4,padding:"2px 8px",fontSize:11,flexShrink:0}}>✦ {dragVisual.label} 移動中</span>
          :(saving
            ?<span style={{background:"#F59E0B",borderRadius:4,padding:"2px 8px",fontSize:11,flexShrink:0}}>💾 保存中</span>
            :<span style={{background:"#22C55E",borderRadius:4,padding:"2px 8px",fontSize:11,flexShrink:0}}>✓ 保存済</span>)
        }
        {/* 確定・公開ボタン */}
        <button onClick={publish} disabled={publishing||!hasUnpublished}
          style={{background:hasUnpublished?"#DC2626":"rgba(255,255,255,0.1)",
            border:`1px solid ${hasUnpublished?"#FCA5A5":"rgba(255,255,255,0.2)"}`,
            color:hasUnpublished?"white":"rgba(255,255,255,0.4)",
            padding:"3px 12px",borderRadius:4,cursor:hasUnpublished?"pointer":"default",
            fontSize:11,fontWeight:700,whiteSpace:"nowrap",flexShrink:0,
            animation:hasUnpublished?"pulse 2s infinite":"none"}}>
          {publishing?"公開中...":hasUnpublished?"⚠ 未確定・要公開":"✅ 確定済"}
        </button>
        {nConfl>0
          ?<button onClick={jumpToNextConflict} title="クリックするたびに、次の重複箇所へ移動して点滅表示します" style={{background:"#EF4444",border:"1px solid #FCA5A5",color:"white",borderRadius:4,padding:"2px 8px",fontSize:11,fontWeight:700,flexShrink:0,cursor:"pointer",whiteSpace:"nowrap"}}>⚠ 重複 {conflictSlots.length||nConfl}件 ▸</button>
          :<span style={{background:"rgba(34,197,94,0.25)",borderRadius:4,padding:"2px 8px",fontSize:11,flexShrink:0}}>✓ 重複なし</span>
        }
        {emptySlots.length>0&&
          <button onClick={jumpToNextEmpty} title="クリックするたびに、次の空き（基本時間割にあるのに今週空のコマ）へ移動して点滅表示します。通級など基本コマが少ない学級は対象外。" style={{background:"#F59E0B",border:"1px solid #FCD34D",color:"white",borderRadius:4,padding:"2px 8px",fontSize:11,fontWeight:700,flexShrink:0,cursor:"pointer",whiteSpace:"nowrap"}}>◻ 空き {emptySlots.length}件 ▸</button>
        }
        <div style={{width:1,height:18,background:"rgba(255,255,255,0.25)",flexShrink:0,margin:"0 2px"}}/>

        {/* 操作 */}
        <button onClick={undo} disabled={historyLen===0} title="元に戻す（Ctrl+Z）" style={{background:historyLen>0?"rgba(255,255,255,0.18)":"rgba(255,255,255,0.06)",border:"1px solid rgba(255,255,255,0.25)",color:historyLen>0?"white":"rgba(255,255,255,0.35)",padding:"3px 10px",borderRadius:4,cursor:historyLen>0?"pointer":"not-allowed",fontSize:11,flexShrink:0,whiteSpace:"nowrap"}}>↩ 取消{historyLen>0&&<span style={{marginLeft:4,background:"rgba(255,255,255,0.25)",borderRadius:8,padding:"0 5px",fontSize:10}}>{historyLen}</span>}</button>
        <button onClick={redo} title="やり直す（Ctrl+Y）" style={{background:"rgba(255,255,255,0.12)",border:"1px solid rgba(255,255,255,0.25)",color:"white",padding:"3px 10px",borderRadius:4,cursor:"pointer",fontSize:11,flexShrink:0,whiteSpace:"nowrap"}}>↪ やり直し</button>
        <div style={{width:1,height:18,background:"rgba(255,255,255,0.25)",flexShrink:0,margin:"0 2px"}}/>

        <HoverMenu icon="🔄" label="ビュー切り替え" items={[
          {icon:"👤",label:"生徒ビュー",desc:"生徒・保護者向けの見え方",color:"#15803D",hover:"#F0FDF4",onClick:()=>setStudentMode(true)},
          {icon:"👩‍🏫",label:"教員ビュー",desc:"先生向けの見え方",color:"#1D4ED8",hover:"#EFF6FF",onClick:()=>setTeacherMode(true)},
        ]}/>
        <div style={{width:1,height:18,background:"rgba(255,255,255,0.25)",flexShrink:0,margin:"0 2px"}}/>

        {/* ── 管理・その他 ── */}
        {!isDemo&&<BackupDropdown saveRef={saveRef} saving={saving} setSaving={setSaving} setBackupModal={setBackupModal} base={base} setBase={setBase} changes={changes} setChanges={setChanges} teachers={teachers} setTeachers={setTeachers} classes={classes} setBench={setBench} openIntegrity={()=>setIntegrityModal({open:true})}/>}
        <HoverMenu icon="⋯" label="その他" items={[
          {icon:"📊",label:"集計",desc:"先生ごとの担当時数など",color:"#047857",hover:"#ECFDF5",onClick:()=>setStatsModal(true)},
          ...(isDemo?[]:[{icon:"🔗",label:"URL管理",desc:"閲覧用URLの発行・管理",color:"#047857",hover:"#ECFDF5",onClick:()=>setUrlModal(true)}]),
        ]}/>
        <div style={{width:1,height:18,background:"rgba(255,255,255,0.25)",flexShrink:0,margin:"0 2px"}}/>

        {/* ── 初期設定（会議管理を含む）── */}
        <HoverMenu icon="⚙" label="初期設定" items={[
          {icon:"⚙",label:"学校の初期設定",desc:"学級・教科・教員・担当など",color:"#1E3A5F",hover:"#F1F5F9",onClick:()=>setSetupOpen(true)},
          {icon:"📋",label:"会議管理",desc:"会議の登録・編集",color:"#6D28D9",hover:"#F5F3FF",badge:meetings.length,onClick:()=>setMeetingModal(true)},
        ]}/>
        <div style={{flex:1}}/>
        {user&&<span style={{fontSize:11,color:"rgba(255,255,255,0.75)",display:"flex",alignItems:"center",gap:4,flexShrink:0,whiteSpace:"nowrap"}}>
          {user.picture&&<img src={user.picture} style={{width:20,height:20,borderRadius:"50%"}}/>}
          {user.name}
        </span>}
        {onLogout&&<button onClick={onLogout} style={{background:"rgba(255,255,255,0.12)",border:"1px solid rgba(255,255,255,0.25)",color:"white",padding:"3px 10px",borderRadius:4,cursor:"pointer",fontSize:11,flexShrink:0,whiteSpace:"nowrap"}}>ログアウト</button>}
      </div>

      {/* ── タブ＋モード＋週ナビ（2行目）── */}
      <div style={{background:"white",borderBottom:"2px solid #E2E8F0",padding:"0 12px",display:"flex",alignItems:"center",height:38,gap:4,overflowX:"auto",scrollbarWidth:"none"}}>
        {[{k:"class",l:"🏫 学級別"},{k:"teacher",l:"👤 授業者別"},{k:"day",l:"📋 授業者一覧"}].map(t=>(
          <button key={t.k} onClick={()=>setView(t.k)} data-tab-type="view" data-tab-val={t.k}
            style={{padding:"0 14px",height:38,border:"none",cursor:"pointer",
              borderBottom:view===t.k?"3px solid #1E3A5F":"3px solid transparent",
              background:"none",fontSize:12,fontWeight:view===t.k?700:400,
              color:view===t.k?"#1E3A5F":"#64748B",whiteSpace:"nowrap",flexShrink:0}}>{t.l}</button>
        ))}
        {/* 週ナビ（週間モード時のみ） */}
        {dateMode&&(
          <>
            <div style={{width:1,height:18,background:"#E2E8F0",flexShrink:0,margin:"0 4px"}}/>
            <button onClick={()=>setWkStart(addD(wkStart,-7))} style={{padding:"3px 10px",border:"1px solid #E2E8F0",borderRadius:4,cursor:"pointer",background:"#F8FAFC",fontSize:13,color:"#334155",flexShrink:0}}>◀</button>
            <span style={{fontSize:12,fontWeight:700,color:"#1E3A5F",whiteSpace:"nowrap",flexShrink:0,minWidth:200,textAlign:"center"}}>{fmtWeek(wkStart,showWeekend)}</span>
            {(()=>{const ab=getABWeek(wkStart,abWeekBase);return ab?(
              <span style={{background:ab==="A"?"#EFF6FF":"#FEF3C7",color:ab==="A"?"#2563EB":"#D97706",
                border:`1.5px solid ${ab==="A"?"#BFDBFE":"#FCD34D"}`,borderRadius:5,
                padding:"2px 10px",fontSize:12,fontWeight:700,flexShrink:0}}>
                {ab}週
              </span>
            ):null;})()}
            <button onClick={()=>setWkStart(addD(wkStart,7))} style={{padding:"3px 10px",border:"1px solid #E2E8F0",borderRadius:4,cursor:"pointer",background:"#F8FAFC",fontSize:13,color:"#334155",flexShrink:0}}>▶</button>
            <button onClick={()=>setWkStart(getMon(todayStr()))} style={{padding:"3px 9px",border:"1px solid #E2E8F0",borderRadius:4,cursor:"pointer",background:"white",fontSize:11,color:"#64748B",flexShrink:0}}>今週</button>
            {wkChg>0&&<span style={{background:"#FEF3C7",color:"#92400E",fontSize:11,padding:"2px 8px",borderRadius:4,border:"1px solid #FDE68A",fontWeight:600,flexShrink:0}}>変更 {wkChg}件</span>}
            {/* ② 一括休日・欠課設定ボタン */}
            <button onClick={()=>setBatchModal(true)}
              style={{padding:"3px 10px",border:"1px solid #FCA5A5",borderRadius:4,cursor:"pointer",background:"#FFF1F2",fontSize:11,color:"#DC2626",fontWeight:700,whiteSpace:"nowrap",flexShrink:0}}>
              🗓 欠課・行事入力
            </button>
          </>
        )}
        <div style={{flex:1}}/>
        {/* ⑤ 期間切り替え（基本時間割モード時に目立たせる） */}
        {!dateMode&&periodDefs.length>0&&(
          <PeriodSwitcher
            periodDefs={periodDefs} setPeriodDefs={setPeriodDefs}
            activePeriodId={activePeriodId}
            switchPeriod={switchPeriod} addPeriod={addPeriod} deletePeriod={deletePeriod}
          />
        )}
        {/* 週間変更モード時：自動切換えされた期間を小さく表示 */}
        {dateMode&&periodDefs.length>1&&(()=>{
          const cur=periodDefs.find(p=>p.id===activePeriodId);
          return cur?(
            <div style={{fontSize:10,color:"#94A3B8",whiteSpace:"nowrap",padding:"2px 8px",
              background:"#F8FAFC",border:"1px solid #E2E8F0",borderRadius:4,flexShrink:0}}
              title="表示中の週に対応する基本時間割期間（自動切換え）">
              📅 {cur.name}
            </div>
          ):null;
        })()}
        {/* 週末表示トグル（週間日課変更モード時のみ） */}
        {dateMode&&(
          <button onClick={()=>setShowWeekend(v=>!v)}
            title="土曜・日曜を表示するかどうか切り替え"
            style={{padding:"4px 10px",border:`1.5px solid ${showWeekend?"#7C3AED":"#E2E8F0"}`,borderRadius:5,cursor:"pointer",
              fontSize:11,fontWeight:showWeekend?700:400,flexShrink:0,
              background:showWeekend?"#EDE9FE":"#F8FAFC",
              color:showWeekend?"#6D28D9":"#64748B",whiteSpace:"nowrap"}}>
            {showWeekend?"🗓 土日あり":"🗓 土日なし"}
          </button>
        )}
        {/* モード切替（右端） */}
        <div style={{display:"flex",borderRadius:5,overflow:"hidden",border:"1px solid #E2E8F0",flexShrink:0}}>
          {[{v:false,l:"📋 基本時間割"},{v:true,l:"📅 週間日課変更"}].map(({v,l})=>(
            <button key={String(v)} onClick={()=>setDateMode(v)} data-tab-type="mode" data-tab-val={String(v)}
              style={{padding:"4px 12px",border:"none",cursor:"pointer",fontSize:11,
                background:dateMode===v?"#1E3A5F":"#F8FAFC",
                color:dateMode===v?"white":"#64748B",
                fontWeight:dateMode===v?700:400,whiteSpace:"nowrap"}}>{l}</button>
          ))}
        </div>
      </div>

      {/* メインレイアウト */}
      <div style={{display:"flex",alignItems:"flex-start"}}>

        {/* 左サイドバー */}
        <div style={{width:110,minWidth:110,flexShrink:0,background:"white",borderRight:"2px solid #E2E8F0",padding:"8px 6px"}}>
          <div style={{display:'flex',alignItems:'center',gap:4,marginBottom:6}}>
            <span style={{fontSize:11,fontWeight:700,color:'#475569'}}>🗂 待機</span>
            <button onClick={()=>setBench(Array(8).fill(null))}
              style={{marginLeft:'auto',fontSize:9,padding:'1px 5px',border:'1px solid #E2E8F0',borderRadius:3,cursor:'pointer',background:'#F8FAFC',color:'#64748B'}}>
              消去
            </button>
          </div>
          <div style={{display:'flex',flexDirection:'column',gap:4}}>
            {bench.map((entry,idx)=>{
              const hk=`bench-${idx}`;
              const dc={benchIdx:idx,day:null,period:null,date:null,matchCid:null,matchTid:null};
              cellDataRef.current[hk]={entry,dc,onClick:()=>{}};
              const isDragSrc=dragVisual?.srcHk===hk;
              const isDragHov=hoverHk===hk&&!!dragVisual&&!isDragSrc;
              return(
                <div key={idx} data-hk={hk}
                  onPointerDown={e=>{if(e.button!==0||!entry)return;e.preventDefault();dragRef.current={entry,dc,onClick:()=>{},srcHk:hk,startX:e.clientX,startY:e.clientY,moved:false};}}
                  style={{width:'100%',height:54,borderRadius:6,border:isDragHov?'2px solid #22C55E':'2px dashed #CBD5E1',background:isDragHov?'#DCFCE7':isDragSrc?'#BFDBFE':entry?gc(entry.subject):'#F8FAFC',display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',cursor:entry?'grab':'default',userSelect:'none',position:'relative',opacity:isDragSrc?0.4:1,transition:'all 0.1s',flexShrink:0}}>
                  {entry?(
                    <>
                      <div style={{fontSize:10,fontWeight:700,color:'#1E293B'}}>{entry.subject}</div>
                      <div style={{fontSize:9,color:'#64748B'}}>{(entry.classIds||[]).map(c=>cn(c)).join('・')}</div>
                      <div style={{fontSize:9,color:'#64748B'}}>{(entry.teacherIds||[]).map(t=>tn(t)).join('・')}先生</div>
                      {entry._benchDay&&<div style={{fontSize:8,color:'#94A3B8'}}>{entry._benchDay}{entry._benchPeriod}限</div>}
                      <button onClick={e=>{e.stopPropagation();setBench(p=>{const n=[...p];n[idx]=null;return n;})}}
                        style={{position:'absolute',top:2,right:2,background:'rgba(0,0,0,0.1)',border:'none',borderRadius:3,cursor:'pointer',fontSize:9,color:'#6B7280',padding:'0 3px',lineHeight:'14px'}}>×</button>
                    </>
                  ):<div style={{fontSize:13,color:'#E2E8F0'}}>{idx+1}</div>}
                </div>
              );
            })}
          </div>
        </div>

        {/* メインコンテンツ */}
        <div style={{flex:1,padding:"12px 14px",overflow:"auto"}}>

        {view==="class"&&(
          <div>
            <div style={{marginBottom:10,display:"flex",gap:5,flexWrap:"wrap",alignItems:"center"}}>
              <span style={{fontSize:12,color:"#64748B",fontWeight:700,marginRight:3}}>学級：</span>
              {classes.map(c=><button key={c.id} onClick={()=>setSelCls(c.id)} onMouseEnter={e=>hoverSwitch(()=>setSelCls(c.id),e.currentTarget)} onMouseLeave={hoverSwitchCancel} data-tab="cls" data-tab-type="cls" data-tab-val={c.id} style={chip(selCls===c.id)}>{c.name}</button>)}
            </div>
            <div style={{overflowX:"auto"}}>
              <table style={{borderCollapse:"collapse"}}>
                <thead><tr><th style={PTH}>時限</th>{cols.map((c,i)=>(
                  <th key={i} style={{...TH,padding:0,minWidth:100,
                    background:c.isWeekend?"#F5F3FF":"#F1F5F9",
                    color:c.isWeekend?"#5B21B6":"#334155"}}>
                    <div style={{padding:"6px 8px"}}>{c.label}</div>
                    {dateMode&&<DayPatternBadge date={c.date} dayPatterns={dayPatterns} setDayPat={setDayPat}/>}
                  </th>
                ))}</tr></thead>
                <tbody>{PERIODS.map(p=>(
                  <tr key={p}><td style={{...PTH,fontSize:11}}>{p}限</td>
                    {cols.map((c,i)=>{
                      const dayKey=dateMode?dowOf(c.date):activeDays[c.di];
                      // 基本時間割ではA/B週両方のエントリを返す
                      const allBaseEntries=!dateMode?base.filter(e=>e.day===dayKey&&e.period===p&&e.classIds.includes(selCls)):null;
                      const entries=dateMode?gEsForCls(c.date,p,selCls):allBaseEntries&&allBaseEntries.length>0?allBaseEntries:[null];
                      const e=entries[0];
                      const day=dateMode?dowOf(c.date):activeDays[c.di];
                      const be=dateMode?base.find(b=>b.day===getPatDay(c.date,p)&&b.period===getPatPeriod(c.date,p)&&b.classIds.includes(selCls)):null;
                      const hk=`cv${i}${p}`;
                      // 学級別ビューの重複判定: gEsForClsがスロットを1件に畳むため、
                      // base と changes の両方を見て、重複ペアの取りこぼしを防ぐ。
                      const _slotEnts=dateMode
                        ?[...changes.filter(ch=>ch.date===c.date&&ch.period===p&&(ch.classIds||[]).includes(selCls)&&!ch._removed),
                          ...base.filter(b=>b.day===dayKey&&b.period===p&&(b.classIds||[]).includes(selCls)&&isABVisible(b))]
                        :(allBaseEntries||[]);
                      const cellConflict=(e&&conflicts.has(e.id))||_slotEnts.some(x=>x&&conflicts.has(x.id));
                      // 複数isBlockedの場合はMultiCell、それ以外はCellTD
                      if(dateMode&&entries.filter(Boolean).length>1&&entries.every(x=>x?.isBlocked)){
                        return(
                          <MultiCell key={i} entries={entries.filter(Boolean)} conflict={cellConflict} hk={hk} isConflictPulse={conflictPulseHks.has(hk)}
                            dc={{day,period:p,date:c.date||null,matchCid:selCls,matchTid:null}}
                            periodPatternPicker={periodPatternPicker} setPeriodPatternPicker={setPeriodPatternPicker}
                            dayPatterns={dayPatterns} setPeriodPat={setPeriodPat} clearPeriodPat={clearPeriodPat}
                            closeModal={()=>setModal(null)}
                            onClick={()=>{openModal(e,{day,period:p,classIds:[selCls],date:c.date||null,hk});setLastEdited(hk);}}/>
                        );
                      }
                      // 基本時間割でA/B週両方のエントリがある場合は分割表示
                      // A週を左、B週を右に並べる
                      const altEntries=!dateMode?entries.filter(Boolean).sort((a,b)=>(a.altWeek||"")>(b.altWeek||"")?1:-1):[];
                      if(!dateMode&&altEntries.length>=2){
                        return(
                          <td key={i} style={{padding:0,minWidth:90,verticalAlign:"top",border:cellConflict?"3px solid #EF4444":"1px solid #E2E8F0",height:68,position:"relative"}}>
                            {cellConflict&&<div title="重複しています" style={{position:"absolute",top:2,right:2,fontSize:10,fontWeight:800,color:"#DC2626",zIndex:6,lineHeight:1,background:"rgba(255,255,255,0.9)",borderRadius:3,padding:"1px 2px"}}>⚠</div>}                            <div style={{display:"flex",height:"100%",gap:0}}>
                              {altEntries.map((ae,ai)=>(
                                <div key={ae.id} onClick={()=>{openModal(ae,{day,period:p,classIds:[selCls],date:null,hk:`${hk}-${ai}`});setLastEdited(hk);}}
                                  style={{flex:1,padding:"3px 4px",background:gc(ae.subject),cursor:"grab",overflow:"hidden",
                                    borderLeft:ai>0?"1px solid rgba(255,255,255,0.5)":undefined,
                                    display:"flex",flexDirection:"column",justifyContent:"center"}}>
                                  <div style={{fontWeight:700,fontSize:11,color:"#1E293B",display:"flex",alignItems:"center",gap:2}}>
                                    {ae.subject}
                                    <span style={{fontSize:7,fontWeight:700,padding:"0 2px",borderRadius:2,
                                      background:ae.altWeek==="A"?"#DBEAFE":"#FEF3C7",
                                      color:ae.altWeek==="A"?"#1D4ED8":"#B45309"}}>
                                      {ae.altWeek}
                                    </span>
                                  </div>
                                  <div style={{fontSize:9,color:"#64748B"}}>{(ae.teacherIds||[]).map(t=>tn(t)).join("・")}先生</div>
                                </div>
                              ))}
                            </div>
                          </td>
                        );
                      }
                      return(
                      <CellTD key={i} entry={e} conflict={cellConflict} hk={hk} baseEntry={be}
                        dc={{day,period:p,date:c.date||null,matchCid:selCls,matchTid:null}}
                        periodPatternPicker={periodPatternPicker} setPeriodPatternPicker={setPeriodPatternPicker}
                        dayPatterns={dayPatterns} setPeriodPat={setPeriodPat} clearPeriodPat={clearPeriodPat}
                        closeModal={()=>setModal(null)}
                        isConflictPulse={conflictPulseHks.has(hk)}
                        onClick={()=>{openModal(e,{day,period:p,classIds:[selCls],date:c.date||null,hk});setLastEdited(hk);}}/>
                    );})}
                  </tr>
                ))}</tbody>
              </table>
            </div>
          </div>
        )}

        {view==="teacher"&&(
          <div>
            <div style={{marginBottom:10,display:"flex",gap:5,flexWrap:"wrap",alignItems:"center"}}>
              <span style={{fontSize:12,color:"#64748B",fontWeight:700,marginRight:3}}>授業者：</span>
              {teachers.map(t=><button key={t.id} onClick={()=>setSelTch(t.id)} onMouseEnter={e=>hoverSwitch(()=>setSelTch(t.id),e.currentTarget)} onMouseLeave={hoverSwitchCancel} data-tab="tch" data-tab-type="tch" data-tab-val={t.id} style={chip(selTch===t.id)}>{t.name}先生</button>)}
            </div>
            <div style={{overflowX:"auto"}}>
              <table style={{borderCollapse:"collapse"}}>
                <thead><tr><th style={PTH}>時限</th>{cols.map((c,i)=>{
                  const colDay=dateMode?dowOf(c.date||""):activeDays[c.di];
                  const selTchData=teachers.find(t=>t.id===selTch);
                  const colDate2=dateMode?c.date:null;
                  const hasOverride2=colDate2&&teacherDateOverrides.some(o=>o.teacherId===selTch&&o.date===colDate2);
                  const isAbsent=(()=>{try{return colDay&&selTchData?isDayFullyAbsent(selTchData,colDay)&&!hasOverride2:false;}catch(_){return false;}})();
                  return(
                  <th key={i} style={{...TH,padding:0,minWidth:100,
                    background:isAbsent?"#F3F4F6":c.isWeekend?"#F5F3FF":"#F1F5F9",
                    color:isAbsent?"#9CA3AF":c.isWeekend?"#5B21B6":"#334155"}}>
                    <div style={{padding:"6px 8px"}}>
                      {c.label}
                      {isAbsent&&(
                        <div style={{fontSize:8,color:"#9CA3AF",fontWeight:700,marginTop:1}}>
                          不在
                          {dateMode&&colDate2&&(
                            <span onClick={e=>{e.stopPropagation();setTeacherDateOverrides(p=>[...p,{teacherId:selTch,date:colDate2,period:null}]);}}
                              style={{marginLeft:4,color:"#3B82F6",cursor:"pointer",textDecoration:"underline"}}>
                              この日は出勤
                            </span>
                          )}
                        </div>
                      )}
                      {hasOverride2&&(
                        <div style={{fontSize:8,color:"#3B82F6",fontWeight:700,marginTop:1}}>
                          ✓ 出勤（特例）
                          <span onClick={e=>{e.stopPropagation();setTeacherDateOverrides(p=>p.filter(o=>!(o.teacherId===selTch&&o.date===colDate2)));}}
                            style={{marginLeft:4,color:"#EF4444",cursor:"pointer",textDecoration:"underline"}}>
                            解除
                          </span>
                        </div>
                      )}
                    </div>
                    {dateMode&&!isAbsent&&<DayPatternBadge date={c.date} dayPatterns={dayPatterns} setDayPat={setDayPat}/>}
                  </th>
                  );
                })}</tr></thead>
                <tbody>{PERIODS.map(p=>(
                  <tr key={p}><td style={{...PTH,fontSize:11}}>{p}限</td>
                    {cols.map((c,i)=>{
                      const dayKey=dateMode?dowOf(c.date):activeDays[c.di];
                      const es=dateMode?gEs(c.date,p,selTch,true):gEs(dayKey,p,selTch);
                      const day=dateMode?dowOf(c.date):activeDays[c.di];return(
                      <MultiCell key={i} entries={es} conflict={es.some(e=>conflicts.has(e.id))} hk={`tv${i}${p}`} isConflictPulse={conflictPulseHks.has(`tv${i}${p}`)}
                        dc={{day,period:p,date:c.date||null,matchCid:null,matchTid:selTch}}
                        periodPatternPicker={periodPatternPicker} setPeriodPatternPicker={setPeriodPatternPicker}
                        dayPatterns={dayPatterns} setPeriodPat={setPeriodPat} clearPeriodPat={clearPeriodPat}
                        closeModal={()=>setModal(null)} meetingCellMap={meetingCellMap}
                        onClick={()=>{const hk=`tv${i}${p}`;openModal(es[0]||null,{day,period:p,teacherId:selTch,date:c.date||null,hk});setLastEdited(hk);}}/>
                    );})}
                  </tr>
                ))}</tbody>
              </table>
            </div>
          </div>
        )}

        {view==="day"&&(
          <div>
            <div style={{marginBottom:10,display:"flex",gap:5,flexWrap:"wrap",alignItems:"center"}}>
              <span style={{fontSize:12,color:"#64748B",fontWeight:700,marginRight:3}}>曜日：</span>
              {cols.map((c,i)=><button key={i} onClick={()=>setSelDi(i)} onMouseEnter={e=>hoverSwitch(()=>setSelDi(i),e.currentTarget)} onMouseLeave={hoverSwitchCancel} data-tab="di" data-tab-type="di" data-tab-val={String(i)} style={chip(selDi===i)}>{c.label}</button>)}
            </div>
            <div style={{overflowX:"auto",position:"relative"}}>
              <table style={{borderCollapse:"collapse"}}>
                <thead>
                  <tr>
                    <th style={{...PTH,position:"sticky",left:0,zIndex:3}}>時限</th>
                    {teachers.map((t,ti)=>{
                      const colDay=dateMode?dowOf(cols[selDi]?.date||""):activeDays[selDi];
                      const colDate=dateMode?cols[selDi]?.date:null;
                      const hasOverride=colDate&&teacherDateOverrides.some(o=>o.teacherId===t.id&&o.date===colDate);
                      const isAbsent=(()=>{try{return colDay?isDayFullyAbsent(t,colDay)&&!hasOverride:false;}catch(_){return false;}})();
                      const isDragSrc=teacherDragIdx===ti;
                      const isDragOver=teacherDragIdx!==null&&teacherDragIdx!==ti;
                      return(
                        <th key={t.id}
                          draggable
                          onDragStart={e=>{e.dataTransfer.effectAllowed="move";setTeacherDragIdx(ti);}}
                          onDragOver={e=>{e.preventDefault();e.dataTransfer.dropEffect="move";}}
                          onDrop={e=>{
                            e.preventDefault();
                            if(teacherDragIdx===null||teacherDragIdx===ti)return;
                            const arr=[...teachers];
                            const [moved]=arr.splice(teacherDragIdx,1);
                            arr.splice(ti,0,moved);
                            setTeachers(arr);
                            setTeacherDragIdx(null);
                          }}
                          onDragEnd={()=>setTeacherDragIdx(null)}
                          style={{...TH,minWidth:90,cursor:"grab",userSelect:"none",
                            background:isDragSrc?"#DBEAFE":isAbsent?"#F3F4F6":"#F1F5F9",
                            color:isAbsent?"#9CA3AF":"#334155",
                            outline:isDragOver?"2px dashed #6366F1":"none",
                            opacity:isDragSrc?0.5:1,
                            transition:"opacity 0.15s"}}>
                          <div style={{display:"flex",alignItems:"center",justifyContent:"center",gap:3}}>
                            <span style={{fontSize:9,color:"#94A3B8",cursor:"grab"}}>⠿</span>
                            {t.name}先生
                          </div>
                          {isAbsent&&(
                            <div style={{fontSize:8,color:"#9CA3AF",fontWeight:700}}>
                              不在
                              {dateMode&&colDate&&(
                                <span
                                  onClick={e=>{e.stopPropagation();
                                    setTeacherDateOverrides(p=>[...p,{teacherId:t.id,date:colDate,period:null}]);
                                  }}
                                  style={{marginLeft:4,color:"#3B82F6",cursor:"pointer",fontSize:8,textDecoration:"underline"}}>
                                  この日は出勤
                                </span>
                              )}
                            </div>
                          )}
                          {hasOverride&&(
                            <div style={{fontSize:8,color:"#3B82F6",fontWeight:700}}>
                              ✓ 出勤（特例）
                              <span
                                onClick={e=>{e.stopPropagation();
                                  setTeacherDateOverrides(p=>p.filter(o=>!(o.teacherId===t.id&&o.date===colDate)));
                                }}
                                style={{marginLeft:4,color:"#EF4444",cursor:"pointer",fontSize:8,textDecoration:"underline"}}>
                                解除
                              </span>
                            </div>
                          )}
                        </th>
                      );
                    })}
                  </tr>
                </thead>
                <tbody>{PERIODS.map(p=>{
                  const col=cols[selDi];
                  const day=dateMode?dowOf(col.date):activeDays[selDi];
                  return(
                    <tr key={p}>
                      <td style={{...PTH,fontSize:11,position:"sticky",left:0,zIndex:2}}>{p}限</td>
                      {teachers.map(teacher=>{
                        const dayKey=dateMode?dowOf(col.date):activeDays[selDi];
                        const es=dateMode?gEs(col.date,p,teacher.id,true):gEs(dayKey,p,teacher.id);
                        return(
                          <MultiCell key={teacher.id} entries={es} conflict={es.some(e=>conflicts.has(e.id))} hk={`dv${p}${teacher.id}`} isConflictPulse={conflictPulseHks.has(`dv${p}${teacher.id}`)}
                            dc={{day,period:p,date:col.date||null,matchCid:null,matchTid:teacher.id}}
                            meetingCellMap={meetingCellMap}
                            onClick={()=>{const hk=`dv${p}${teacher.id}`;openModal(es[0]||null,{day,period:p,teacherId:teacher.id,date:col.date||null,hk});setLastEdited(hk);}}/>
                        );
                      })}
                    </tr>
                  );
                })}</tbody>
              </table>
            </div>
          </div>
        )}

        {/* Legend */}
        <div style={{marginTop:14,display:"flex",flexWrap:"wrap",gap:4,alignItems:"center"}}>
          <span style={{fontSize:11,color:"#94A3B8"}}>教科：</span>
          {subjects.map(s=><span key={s} style={{background:gc(s),padding:"1px 7px",borderRadius:3,fontSize:11,border:"1px solid #E2E8F0",color:"#334155"}}>{s}</span>)}
          <span style={{background:"#FEF3C7",color:"#B45309",padding:"1px 7px",borderRadius:3,fontSize:11,border:"1px solid #FDE68A",fontWeight:700,marginLeft:4}}>変更</span>
          <span style={{background:"#FEE2E2",color:"#DC2626",padding:"1px 7px",borderRadius:3,fontSize:11,border:"1px solid #FECACA",fontWeight:700}}>補欠</span>
          <span style={{background:"#EDE9FE",color:"#6366F1",padding:"1px 7px",borderRadius:3,fontSize:11,border:"1px solid #DDD6FE",fontWeight:700}}>合同</span>
          <span style={{background:"#CFFAFE",color:"#0891B2",padding:"1px 7px",borderRadius:3,fontSize:11,border:"1px solid #A5F3FC",fontWeight:700}}>TT</span>
          <span style={{background:"repeating-linear-gradient(45deg,#F3F4F6,#F3F4F6 4px,#E5E7EB 4px,#E5E7EB 8px)",color:"#6B7280",padding:"1px 7px",borderRadius:3,fontSize:11,border:"1px solid #D1D5DB",fontWeight:700}}>🚫 空き</span>
        </div>
        <div style={{marginTop:5,fontSize:11,color:"#94A3B8"}}>基本{base.length}コマ ／ 変更{changes.length}件 ／ {classes.length}学級 ／ {teachers.length}名</div>
        </div>
      </div>

      {/* 未配置の駒 */}
      <div style={{margin:"0 0 16px 0",background:"white",borderTop:"2px solid #E2E8F0",padding:"10px 14px"}}>
        <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:8,flexWrap:"wrap"}}>
          <span style={{fontSize:12,fontWeight:700,color:"#DC2626"}}>📋 未配置の駒</span>
          <span style={{background:"#FEE2E2",color:"#DC2626",borderRadius:4,padding:"1px 8px",fontSize:11,fontWeight:700}}>{unplacedLessons.length}コマ</span>
          <span style={{fontSize:11,color:"#94A3B8"}}>時間割にドラッグして配置。</span>
        </div>
        {unplacedLessons.length===0?(
          <div style={{color:"#22C55E",fontSize:12,fontWeight:700,padding:"4px 0"}}>✓ 全コマ配置済み</div>
        ):(()=>{
          const grouped={};
          unplacedLessons.forEach(e=>{const cid=e.classIds[0];if(!grouped[cid])grouped[cid]=[];grouped[cid].push(e);});
          // classes の順序に合わせてタグを並べる
          const cids=[...classes.map(c=>c.id).filter(id=>grouped[id]),...Object.keys(grouped).filter(id=>!classes.find(c=>c.id===id))];
          const filterCid=unplacedFilterCid;
          const visibleEntries=filterCid==="all"?unplacedLessons:(grouped[filterCid]||[]);
          return(
            <div>
              <div style={{display:"flex",gap:4,marginBottom:8,flexWrap:"wrap"}}>
                <button onClick={()=>setUnplacedFilterCid("all")}
                  style={{padding:"2px 10px",border:"1.5px solid",borderRadius:12,cursor:"pointer",fontSize:11,fontWeight:filterCid==="all"?700:400,borderColor:filterCid==="all"?"#DC2626":"#E2E8F0",background:filterCid==="all"?"#DC2626":"white",color:filterCid==="all"?"white":"#64748B"}}>
                  全て（{unplacedLessons.length}）
                </button>
                {cids.map(cid=>(
                  <button key={cid} onClick={()=>setUnplacedFilterCid(cid)}
                    style={{padding:"2px 10px",border:"1.5px solid",borderRadius:12,cursor:"pointer",fontSize:11,fontWeight:filterCid===cid?700:400,borderColor:filterCid===cid?"#1E3A5F":"#E2E8F0",background:filterCid===cid?"#1E3A5F":"white",color:filterCid===cid?"white":"#64748B"}}>
                    {cn(cid)}（{grouped[cid].length}）
                  </button>
                ))}
              </div>
              <div style={{display:"flex",gap:5,flexWrap:"wrap"}}>
                {visibleEntries.map((entry)=>{
                  const hk=`unplaced-${unplacedLessons.indexOf(entry)}`;
                  const dc={benchIdx:null,isUnplaced:true,day:null,period:null,date:null,matchCid:entry.classIds[0],matchTid:entry.teacherIds[0]};
                  cellDataRef.current[hk]={entry,dc,onClick:()=>{}};
                  const isDragSrc=dragVisual?.srcHk===hk;
                  const isDragHov=hoverHk===hk&&!!dragVisual&&!isDragSrc;
                  return(
                    <div key={entry.id} data-hk={hk}
                      onPointerDown={e=>{if(e.button!==0)return;e.preventDefault();dragRef.current={entry,dc,onClick:()=>{},srcHk:hk,startX:e.clientX,startY:e.clientY,moved:false};}}
                      style={{width:84,height:62,borderRadius:7,
                        border:isDragHov?"2px solid #22C55E":"1.5px solid rgba(0,0,0,0.08)",
                        background:isDragHov?"#DCFCE7":isDragSrc?"rgba(191,219,254,0.5)":gc(entry.subject),
                        display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",
                        cursor:"grab",userSelect:"none",opacity:isDragSrc?0.35:1,
                        transition:"all 0.1s",flexShrink:0,position:"relative"}}>
                      <div style={{fontSize:11,fontWeight:700,color:"#1E293B"}}>{entry.subject}</div>
                      <div style={{fontSize:10,color:"#475569"}}>{cn(entry.classIds[0])}</div>
                      <div style={{fontSize:10,color:"#64748B"}}>{entry._teacherName}先生</div>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })()}
      </div>

      {modal&&!periodPatternPicker&&<EditModal modal={modal} base={base} changes={changes} teachers={teachers} classes={classes} subjects={subjects}
        dateMode={dateMode} onSaveBase={saveBase} onSaveBaseKeepOpen={u=>saveBase(u,true)} onAddBase={addBase} onDelBase={delBase}
        onSaveChange={saveChange} onClearChange={clearChange}
        onOpenPeriodPattern={ev=>{
          if(!modal?.date||!modal?.period)return;
          setPeriodPatternPicker({date:modal.date,period:modal.period,
            x:(ev?.clientX??window.innerWidth/2)-110,y:Math.max(20,(ev?.clientY??window.innerHeight/2)-160)});
        }}
        onClose={()=>setModal(null)}/>}
      {setupOpen&&<SetupModal
        schoolName={schoolName} setSchoolName={setSchoolName}
        adminEmails={adminEmails} setAdminEmails={setAdminEmails}
        classes={classes} setClasses={setClasses}
        subjects={subjects} setSubjects={setSubjects}
        weeklyPlan={weeklyPlan} setWeeklyPlan={setWeeklyPlan}
        schoolSlots={schoolSlots} setSchoolSlots={setSchoolSlots}
        abWeekBase={abWeekBase} setAbWeekBase={setAbWeekBase}
        teachers={teachers} setTeachers={setTeachers}
        changes={changes}
        onApplyHoliday={applyHolidayBatch}
        onRemoveBlocked={removeBatchBlocked}
        isDemo={isDemo}
        onClose={()=>setSetupOpen(false)}/>}

      {/* ピッカー開いているとき背景オーバーレイ（クリックで閉じる） */}
      {periodPatternPicker&&(
        <>
          <div style={{position:"fixed",inset:0,zIndex:99990}}
            onPointerDown={()=>setPeriodPatternPicker(null)}/>
          <PeriodPatternPicker
            date={periodPatternPicker.date} period={periodPatternPicker.period}
            x={periodPatternPicker.x} y={periodPatternPicker.y}
            dayPatterns={dayPatterns} setPeriodPat={setPeriodPat} clearPeriodPat={clearPeriodPat}
            onClose={()=>setPeriodPatternPicker(null)}/>
        </>
      )}

      {/* blockPicker 用オーバーレイ（外側クリックで閉じる） */}
      {blockPicker&&(
        <div style={{position:"fixed",inset:0,zIndex:40}}
          onPointerDown={()=>setBlockPicker(null)}/>
      )}

      {/* ── ④ BackupRestoreModal ── */}
      {backupModal&&(
        <BackupRestoreModal
          onRestore={async(id)=>{
            try{
              const d=await sbRestoreBackup(id);
              if(!d){alert('データが見つかりませんでした。');return;}
              if(d.base?.length)     setBase(d.base);
              if(d.changes?.length)  setChanges(d.changes);
              if(d.teachers?.length) setTeachers(d.teachers);
              if(d.schoolName)       setSchoolName(d.schoolName);
              if(d.classes?.length)  setClasses(d.classes);
              if(d.subjects?.length) setSubjects(d.subjects);
              if(d.weeklyPlan)       setWeeklyPlan(d.weeklyPlan);
              if(d.schoolSlots)      setSchoolSlots(d.schoolSlots);
              setBackupModal(false);
              alert('復元しました。');
            }catch(e){alert('復元に失敗しました。');}
          }}
          onClose={()=>setBackupModal(false)}
        />
      )}

      {/* ── ② BatchBlockModal ── */}
      {batchModal&&(
        <BatchBlockModal
          classes={classes}
          wkStart={wkStart}
          changes={changes}
          onApply={applyBatchBlock}
          onRemoveBlocked={removeBatchBlocked}
          onApplyPattern={applyPeriodPattern}
          initialTab={typeof batchModal==="string"?batchModal:"input"}
          onClose={()=>setBatchModal(false)}
        />
      )}

      {/* ── 🚫 空き理由ピッカー（グローバル・position:fixed で画面内に収める） ── */}
      {blockPicker&&(()=>{
        // 授業者ビュー（teacherIdsあり・学級別でない）は直接「出張」でトグル登録/解除
        const isTeacherView=blockPicker.teacherIds?.length>0&&!blockPicker.isClassView;
        if(isTeacherView){
          const cids=blockPicker.classIds;const tids=blockPicker.teacherIds;
          // 【v8_7_19】出張は先生ごとのもの。判定・削除は「先生(teacherIds)も一致」を条件にする。
          //   空きセルでは cids がその先生の担当全クラスになるため、クラス一致だけだと
          //   同じ時限・同じクラスを担当する別の先生の出張まで誤って消してしまう不具合を防ぐ。
          const isThisTrip=x=>x.date===blockPicker.date&&x.period===blockPicker.period&&x.isBlocked&&x.note==="出張"
            &&cids.some(cid=>(x.classIds||[]).includes(cid))
            &&(tids||[]).some(tid=>(x.teacherIds||[]).includes(tid));
          const alreadyBlocked=changes.some(isThisTrip);
          setChangesH(p=>{
            let result=p.filter(x=>!isThisTrip(x));
            if(!alreadyBlocked){
              cids.forEach((cid,i)=>{
                result.push({id:Date.now()+i,date:blockPicker.date,period:blockPicker.period,classIds:[cid],teacherIds:tids,subject:"",isSubst:false,isBlocked:true,note:"出張"});
              });
            }
            return result;
          });
          setBlockPicker(null);
          return null;
        }
        const px=blockPicker.x||200;
        const py=blockPicker.y||100;
        const popW=230;
        const popH=360; // 実際の高さに余裕を持たせた値
        // 右に置けるか、なければ左に
        const left=px+popW<=window.innerWidth-8?px:Math.max(8,px-popW-8);
        // 下に置けるか、なければ上に（セルの上端から上方向）
        const top=py+popH<=window.innerHeight-8?py:Math.max(8,py-popH);
        return(
          <div onClick={()=>setBlockPicker(null)}
            style={{position:"fixed",inset:0,zIndex:9999,background:"transparent"}}>
            <div onClick={e=>e.stopPropagation()}
              style={{position:"fixed",top,left,zIndex:10000,background:"white",border:"2px solid #374151",
                borderRadius:8,padding:"10px 12px",boxShadow:"0 8px 32px rgba(0,0,0,0.25)",minWidth:200,maxHeight:"80vh",overflowY:"auto"}}>
              <div style={{fontSize:11,fontWeight:700,color:"#374155",marginBottom:7}}>🚫 空きの理由</div>
              {blockPicker.classIds?.length>0&&(
                <div style={{fontSize:10,color:"#6B7280",marginBottom:6,padding:"3px 6px",background:"#F3F4F6",borderRadius:4}}>
                  対象：{blockPicker.classIds.map(c=>cn(c)).join("・")}
                </div>
              )}
              {/* 元に戻す */}
              <button onClick={()=>{
                const cids=blockPicker.classIds;
                setChangesH(p=>p.filter(x=>!(x.date===blockPicker.date&&x.period===blockPicker.period&&cids.some(cid=>(x.classIds||[]).includes(cid))&&x.isBlocked)));
                setBlockPicker(null);
              }} style={{display:"block",width:"100%",textAlign:"left",padding:"5px 10px",marginBottom:6,border:"1.5px solid #BBF7D0",borderRadius:5,cursor:"pointer",fontSize:13,background:"#F0FDF4",color:"#15803D",fontWeight:700}}>
                ♻ 元に戻す（空き解除）
              </button>
              <div style={{fontSize:10,color:"#6B7280",marginBottom:5}}>理由：</div>
              {[{r:"欠課",icon:"📋"},{r:"出張",icon:"🚙"},{r:"行事",icon:"🎌"},{r:"その他",icon:"📝"}].map(({r,icon})=>(
                <div key={r}>
                  <button onClick={()=>{
                    if(r==="欠課"||r==="出張"){
                      const cids=blockPicker.classIds;const tids=blockPicker.teacherIds||[];
                      setChangesH(p=>{let result=[...p];cids.forEach((cid,i)=>{
                        // 同じ note の isBlocked のみ削除（別の行事・欠課エントリは残す）
                        result=result.filter(x=>!(x.date===blockPicker.date&&x.period===blockPicker.period&&x.classIds.includes(cid)&&x.isBlocked&&x.note===r));
                        result.push({id:Date.now()+i,date:blockPicker.date,period:blockPicker.period,classIds:[cid],teacherIds:tids,subject:"",isSubst:false,isBlocked:true,note:r});
                      });return result;});
                      setBlockPicker(null);
                    }else{
                      setBlockPicker(p=>({...p,inputMode:r,inputVal:""}));
                    }
                  }} style={{display:"block",width:"100%",textAlign:"left",padding:"5px 10px",marginBottom:3,border:"1px solid #E5E7EB",borderRadius:5,cursor:"pointer",fontSize:13,background:"white",color:"#1F2937"}}>
                    {icon} {r}
                  </button>
                  {blockPicker.inputMode===r&&(
                    <div style={{marginBottom:6,display:"flex",gap:4}}>
                      <input autoFocus value={blockPicker.inputVal||""} onChange={e=>setBlockPicker(p=>({...p,inputVal:e.target.value}))}
                        placeholder={r==="行事"?"行事名（例：体育祭）":"理由を入力"}
                        style={{flex:1,padding:"4px 8px",border:"1.5px solid #374151",borderRadius:5,fontSize:12}}
                        onKeyDown={e=>{if(e.key!=="Enter")return;
                          const note=`${r}：${blockPicker.inputVal||""}`;
                          const cids=blockPicker.classIds;const tids=blockPicker.teacherIds||[];
                          setChangesH(p=>{let result=[...p];cids.forEach((cid,i)=>{result=result.filter(x=>!(x.date===blockPicker.date&&x.period===blockPicker.period&&x.classIds.includes(cid)&&x.isBlocked&&x.note===note));result.push({id:Date.now()+i,date:blockPicker.date,period:blockPicker.period,classIds:[cid],teacherIds:tids,subject:"",isSubst:false,isBlocked:true,note});});return result;});
                          setBlockPicker(null);
                        }}/>
                      <button onClick={()=>{
                        const note=`${r}：${blockPicker.inputVal||""}`;
                        const cids=blockPicker.classIds;const tids=blockPicker.teacherIds||[];
                        setChangesH(p=>{let result=[...p];cids.forEach((cid,i)=>{result=result.filter(x=>!(x.date===blockPicker.date&&x.period===blockPicker.period&&x.classIds.includes(cid)&&x.isBlocked&&x.note===note));result.push({id:Date.now()+i,date:blockPicker.date,period:blockPicker.period,classIds:[cid],teacherIds:tids,subject:"",isSubst:false,isBlocked:true,note});});return result;});
                        setBlockPicker(null);
                      }} style={{padding:"4px 8px",background:"#374151",color:"white",border:"none",borderRadius:5,cursor:"pointer",fontSize:12}}>決定</button>
                    </div>
                  )}
                </div>
              ))}
              <button onClick={()=>setBlockPicker(null)} style={{display:"block",width:"100%",textAlign:"center",padding:"4px",marginTop:4,border:"none",borderRadius:5,cursor:"pointer",fontSize:11,background:"#F3F4F6",color:"#6B7280"}}>キャンセル</button>
            </div>
          </div>
        );
      })()}

      {/* ── 祝日一括登録モーダル ── */}
      {holidayModal&&(
        <HolidayImportModal
          classes={classes}
          changes={changes}
          onApply={applyHolidayBatch}
          onRemoveBlocked={removeBatchBlocked}
          onClose={()=>setHolidayModal(false)}
        />
      )}

      {/* ── 🔗 連動移動調整モーダル ── */}
      {linkAdjustModal&&(
        <LinkAdjustModal
          modal={linkAdjustModal}
          classes={classes}
          teachers={teachers}
          base={base}
          setBase={setBase}
          setMovedIds={setMovedIds}
          setLinkNotice={setLinkNotice}
          onClose={()=>setLinkAdjustModal(null)}
        />
      )}
      {/* ── 🔍 データ整合性チェックモーダル ── */}
      {integrityModal&&(
        <IntegrityModal
          base={base} setBase={setBase}
          changes={changes} setChanges={setChanges}
          teachers={teachers} setTeachers={setTeachers}
          classes={classes}
          saveRef={saveRef} setSaving={setSaving}
          onClose={()=>setIntegrityModal(null)}
        />
      )}

      {/* ── 📊 集計モーダル ── */}
      {statsModal&&(
        <StatsModal
          base={base} changes={changes}
          classes={classes} subjects={subjects}
          getPatDay={getPatDay} getPatPeriod={getPatPeriod}
          onClose={()=>setStatsModal(false)}
        />
      )}

      {/* ── 管理者管理モーダル ── */}
      {adminMgrOpen&&(
        <AdminManagerModal currentEmail={user?.email||""} onClose={()=>setAdminMgrOpen(false)}/>
      )}

      {/* ── 重複解消トライアルパネル ── */}
      {conflictResolveModal&&(
        <ConflictTrialPanel
          modal={conflictResolveModal}
          classes={classes}
          teachers={teachers}
          dateMode={dateMode}
          onMinimizeChange={setPanelMinimized}
          onClose={()=>{setConflictResolveModal(null);setCandidateTargetPulse(null);trialHiRef.current=null;setPanelMinimized(false);}}
          onUndo={()=>{
            // トライアル開始前のスナップショットへ一発で復元（手数・タイミングに依存しない）
            const snap=trialSnapRef.current;
            if(snap){
              skipHistoryRef.current=true;
              setBase(snap.base);
              setChanges(snap.changes);
            }else{
              undo();
            }
            // やり直しで重複相手が元位置に戻るため、相手ハイライトを復活
            const m=conflictResolveModal;
            if(m&&trialHiRef.current){
              const confSlots=(m.conflictItems||[]).map(it=>m.dateMode
                ?{period:m.tgtDc.period,date:m.tgtDc.date,day:dowOf(m.tgtDc.date),tids:it.entry.teacherIds||[],cids:it.entry.classIds||[]}
                :{period:m.tgtDc.period,day:m.tgtDc.day,tids:it.entry.teacherIds||[],cids:it.entry.classIds||[]});
              trialHiRef.current={...trialHiRef.current,conflicts:confSlots};
            }
          }}
        />
      )}

      {/* ── 学級空き通知 ── */}
      {emptyClassNotice&&(
        <EmptyClassNotice
          notice={emptyClassNotice}
          classes={classes}
          onClose={()=>setEmptyClassNotice(null)}
          onJump={(classId,period,date)=>{
            setEmptyClassNotice(null);
            setView('class');
            setSelCls(classId);
          }}
        />
      )}

      {/* ── 3コマ回転ダイアログ ── */}
      {chainModal&&(
        <ChainSwapModal
          chainModal={chainModal}
          base={base}
          dateMode={dateMode}
          classes={classes}
          teachers={teachers}
          executeChainSwap={executeChainSwap}
          onClose={()=>setChainModal(null)}
        />
      )}
      {/* ── 玉突き提案ダイアログ ── */}
      {fillHoleModal&&(
        <FillHoleModal
          modal={fillHoleModal}
          classes={classes}
          teachers={teachers}
          onExec={executeFillHoleChain}
          onClose={()=>setFillHoleModal(null)}
        />
      )}
      {urlModal&&(
        <UrlManageModal
          classes={classes}
          onClose={()=>setUrlModal(false)}
        />
      )}
      {meetingModal&&(
        <MeetingModal
          meetings={meetings}
          setMeetings={setMeetings}
          teachers={teachers}
          onClose={()=>setMeetingModal(false)}
        />
      )}
    </div>
  );
}

// ── exportHtml ────────────────────────────────────────────────────────────────
function exportHtml(schoolName,classes,teachers,base,changes,cid,label){
  const isAll=!cid;
  const cls=classes.find(c=>c.id===cid);
  const clsName=label||(cls?cls.name:cid);
  const tnE=id=>(teachers||[]).find(t=>t.id===id)?.name||id;
  const baseEntries=isAll?base:base.filter(e=>(e.classIds||[]).includes(cid));
  const changesFiltered=isAll?changes:changes.filter(c=>(c.classIds||[]).includes(cid));
  const initCid=isAll?(classes[0]?.id||''):cid;
  const SC=JSON.stringify({"国語":"#FDE8E8","数学":"#DBEAFE","英語":"#D1FAE5","理科":"#DCFCE7","社会":"#FEF9C3","音楽":"#EDE9FE","美術":"#FEE2CC","体育":"#BAE6FD","技術":"#CCFBF1","家庭":"#FCE7F3","道徳":"#E0F2FE","学活":"#F3E8FF","総合":"#FEF3C7","生活":"#ECFDF5","自立":"#E0F7FA","図工":"#FFFBEB"});
  const parts=[];
  parts.push('<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8">');
  parts.push('<meta name="viewport" content="width=device-width,initial-scale=1">');
  parts.push('<title>'+schoolName+' '+clsName+' 時間割</title>');
  parts.push('<style>body{margin:0;font-family:\'Hiragino Sans\',sans-serif;background:#F0FDF4;}');
  parts.push('.hdr{background:#15803D;color:white;padding:0 14px;display:flex;align-items:center;height:52px;gap:8px;}');
  parts.push('.hdr h1{font-size:15px;margin:0;flex:1;}.wbtn{padding:4px 10px;border:none;background:rgba(255,255,255,0.2);color:white;border-radius:4px;cursor:pointer;font-size:13px;}');
  parts.push('.mod{display:flex;border-radius:5px;overflow:hidden;border:1px solid rgba(255,255,255,0.4);}.mbtn{padding:4px 10px;border:none;cursor:pointer;font-size:11px;color:white;}');
  parts.push('.cls{background:#DCFCE7;border-bottom:1px solid #BBF7D0;padding:8px 14px;font-size:14px;font-weight:700;color:#15803D;}');
  parts.push('.cnt{padding:14px;overflow-x:auto;}table{border-collapse:collapse;}');
  parts.push('th,td{border:1px solid #D1FAE5;padding:8px;text-align:center;min-width:100px;vertical-align:middle;}');
  parts.push('.ph{background:#1E5F3A;color:white;min-width:42px;font-size:12px;font-weight:700;}.dh{background:#F0FDF4;color:#14532D;font-size:12px;font-weight:700;white-space:pre;}');
  parts.push('.bd{font-size:10px;font-weight:700;margin-bottom:2px;}.bc{color:#B45309;}.bs{color:#DC2626;}');
  parts.push('.sj{font-size:17px;font-weight:700;color:#1E293B;margin-bottom:3px;}.tc{font-size:12px;color:#475569;}');
  parts.push('.lg{margin-top:10px;display:flex;gap:8px;font-size:11px;color:#6B7280;}');
  parts.push('.lc{background:#FEF3C7;color:#B45309;padding:1px 8px;border-radius:3px;border:1px solid #FDE68A;font-weight:700;}');
  parts.push('.ls{background:#FEE2E2;color:#DC2626;padding:1px 8px;border-radius:3px;border:1px solid #FECACA;font-weight:700;}');
  parts.push('.lk{margin-top:16px;padding:10px 14px;background:#DCFCE7;border-radius:8px;font-size:11px;color:#15803D;border:1px solid #BBF7D0;}');
  parts.push('.cbtn{padding:4px 12px;border:1.5px solid #86EFAC;border-radius:16px;cursor:pointer;font-size:12px;margin:0 3px 3px 0;background:white;color:#15803D;}');
  parts.push('.cbtn.on{background:#15803D;color:white;border-color:#15803D;font-weight:700;}');
  parts.push('</style></head><body>');
  parts.push('<div class="hdr"><span style="font-size:20px">🎒</span><h1>'+schoolName+' '+clsName+'</h1>');
  parts.push('<div class="mod"><button class="mbtn" id="bb" onclick="setM(false)" style="background:rgba(255,255,255,0.3);font-weight:700">基本</button>');
  parts.push('<button class="mbtn" id="bw" onclick="setM(true)">週間変更</button></div>');
  parts.push('<span id="wn" style="display:none;align-items:center;gap:6px">');
  parts.push('<button class="wbtn" onclick="sh(-7)">◀</button><span id="wl" style="font-size:12px;font-weight:700;min-width:180px;text-align:center"></span>');
  parts.push('<button class="wbtn" onclick="sh(7)">▶</button><button class="wbtn" style="font-size:11px" onclick="gt()">今週</button></span></div>');
  parts.push('<div class="cls">🏫 '+clsName+'</div>');
  if(isAll){
    parts.push('<div style="background:white;border-bottom:2px solid #BBF7D0;padding:8px 14px;display:flex;align-items:center;flex-wrap:wrap;gap:4px">');
    parts.push('<span style="font-size:12px;font-weight:700;color:#15803D;margin-right:4px">クラス：</span>');
    parts.push('<span id="cbts"></span></div>');
    parts.push('<div class="cls" id="clsn"></div>');
  }else{
    parts.push('<div class="cls">🏫 '+clsName+' の時間割</div>');
  }
  parts.push('<div class="cnt"><div id="tt"></div>');
  parts.push('<div class="lg"><span class="lc">変更</span><span class="ls">補欠</span><span>— 空き</span></div>');
  parts.push('<div class="lk">🔒 このページは閲覧専用です。</div></div>');
  const scriptContent=[
    'var B='+JSON.stringify(baseEntries)+';',
    'var C='+JSON.stringify(changesFiltered)+';',
    'var T='+JSON.stringify(teachers.map(t=>({id:t.id,name:t.name})))+';',
    'var SC='+SC+';',
    isAll?'var CLS='+JSON.stringify(classes.map(c=>({id:c.id,name:c.name})))+';':'',
    'var cid="'+initCid+'";',
    'var dm=false,wk=gm(td());',
    'function ls(d){return d.getFullYear()+"-"+("0"+(d.getMonth()+1)).slice(-2)+"-"+("0"+d.getDate()).slice(-2);}',
    'function td(){return ls(new Date());}',
    'function ad(ds,n){var d=new Date(ds+"T00:00:00");d.setDate(d.getDate()+n);return ls(d);}',
    'function gm(ds){var d=new Date(ds+"T00:00:00"),w=d.getDay();d.setDate(d.getDate()+(w===0?-6:1-w));return ls(d);}',
    'function fw(m){var s=new Date(m+"T00:00:00"),e=new Date(ad(m,4)+"T00:00:00");return s.getFullYear()+"年 "+(s.getMonth()+1)+"/"+s.getDate()+"（月）〜"+(e.getMonth()+1)+"/"+e.getDate()+"（金）";}',
    'function dw(ds){var w=new Date(ds+"T00:00:00").getDay();return w>=1&&w<=5?["月","火","水","木","金"][w-1]:null;}',
    'function tn(id){var t=T.find(function(x){return x.id===id;});return t?t.name:id;}',
    'function gc(s){return SC[s]||"#F8F8F8";}',
    'function ge(day,date,p){if(dm){var chgs=C.filter(function(c){return c.date===date&&c.period===p&&(c.classIds||[]).indexOf(cid)>=0;});var blk=chgs.find(function(c){return c.isBlocked;});if(blk)return Object.assign({},blk,{_ch:true});var les=chgs.find(function(c){return !c._removed;});if(les)return Object.assign({},les,{_ch:true});if(chgs.length>0)return null;var dow=dw(date);if(!dow)return null;return B.find(function(e){return e.day===dow&&e.period===p&&(e.classIds||[]).indexOf(cid)>=0;})||null;}return B.find(function(e){return e.day===day&&e.period===p&&(e.classIds||[]).indexOf(cid)>=0;})||null;}',
    'function render(){',
    '  var DAYS=["月","火","水","木","金"];',
    '  var dates=Array.from({length:5},function(_,i){return ad(wk,i);});',
    '  var cols=dm?dates.map(function(dt,i){var d=new Date(dt+"T00:00:00");return{label:DAYS[i]+"\\n"+(d.getMonth()+1)+"/"+d.getDate(),date:dt,di:i};})   :DAYS.map(function(d,i){return{label:d+"曜日",di:i};});',
    '  document.getElementById("wn").style.display=dm?"flex":"none";',
    '  document.getElementById("wl").textContent=fw(wk);',
    '  document.getElementById("bb").style.background=dm?"transparent":"rgba(255,255,255,0.3)";',
    '  document.getElementById("bb").style.fontWeight=dm?"400":"700";',
    '  document.getElementById("bw").style.background=dm?"rgba(255,255,255,0.3)":"transparent";',
    '  document.getElementById("bw").style.fontWeight=dm?"700":"400";',
    '  var h="<table><thead><tr><th class=\'ph\'>時限</th>";',
    '  cols.forEach(function(c){h+="<th class=\'dh\'>"+c.label+"</th>";});',
    '  h+="</tr></thead><tbody>";',
    '  for(var p=1;p<=6;p++){h+="<tr><td class=\'ph\' style=\'font-size:11px\'>"+p+"限</td>";',
    '    cols.forEach(function(col){',
    '      var e=ge(col.di!=null?["月","火","水","木","金"][col.di]:"",col.date||"",p);',
    '      var isBlk=e&&e.isBlocked;',
    '      var bg=isBlk?"#F9FAFB":e?gc(e.subject):"#FAFAFA";',
    '      var bl=e&&e._ch?(e.isSubst?"4px solid #EF4444":"4px solid #F59E0B"):"1px solid #D1FAE5";',
    '      h+="<td style=\'background:"+bg+";border:1px solid #D1FAE5;border-left:"+bl+";padding:10px 8px;height:72px;min-width:100px;vertical-align:middle;text-align:center\'>";',
    '      if(isBlk)h+="<div style=\'display:inline-flex;align-items:center;gap:3px;background:rgba(55,65,81,0.85);color:white;border-radius:4px;padding:2px 8px;font-size:11px;font-weight:700\'>🚫 "+(e.note||"空き")+"</div>";',
    '      else if(e){if(e._ch)h+="<div class=\'bd "+(e.isSubst?"bs":"bc")+"\'>"+(e.isSubst?"補欠":"変更")+"</div>";',
    '        h+="<div class=\'sj\'>"+e.subject+"</div>";',
    '        h+="<div class=\'tc\'>"+(e.teacherIds||[]).map(tn).join("・")+"先生</div>";',
    '        if((e.classIds||[]).length>1)h+="<div style=\'font-size:10px;color:#6366F1\'>合同授業</div>";',
    '        if(e.note)h+="<div style=\'font-size:10px;color:#9CA3AF;margin-top:2px\'>📝"+e.note+"</div>";',
    '      }else h+="<span style=\'color:#E2E8F0;font-size:20px\'>—</span>";',
    '      h+="</td>";',
    '    });h+="</tr>";}h+="</tbody></table>";',
    '  document.getElementById("tt").innerHTML=h;',
    '}',
    'function setM(v){dm=v;render();}',
    'function sh(n){wk=ad(wk,n);render();}',
    'function gt(){wk=gm(td());render();}',
    isAll?'function sc(id){cid=id;uc();render();}':'',
    isAll?[
      'function uc(){',
      '  var bt=document.getElementById("cbts");if(!bt)return;',
      '  var h="";',
      '  CLS.forEach(function(c){',
      '    h+="<button class=\'cbtn"+(cid===c.id?" on":"")+"\'  data-id=\'"+c.id+"\'>"+c.name+"<\/button>";',
      '  });',
      '  bt.innerHTML=h;',
      '  bt.onclick=function(e){var b=e.target;while(b&&b.tagName!=="BUTTON")b=b.parentElement;if(b&&b.dataset.id)sc(b.dataset.id);};',
      '  var cn=document.getElementById("clsn");',
      '  if(cn){var nm=CLS.find(function(x){return x.id===cid;});cn.textContent="\\uD83C\\uDFEB "+(nm?nm.name:"")+" \\u306E\\u6642\\u9593\\u5272";}',
      '}',
    ].join('\n'):'',
    isAll?'uc();':'',
    'render();',
  ].join('\n');
  parts.push('<script>'+scriptContent+'<\/script>');
  parts.push('</body></html>');
  const html=parts.join('');
  const filename=schoolName+'_'+clsName+'_時間割.html';
  try{
    const blob=new Blob([html],{type:'text/html;charset=utf-8'});
    const url=URL.createObjectURL(blob);
    const w=window.open(url,'_blank','noopener');
    if(!w){
      const a=document.createElement('a');
      a.href=url;a.download=filename;a.style.display='none';
      document.body.appendChild(a);a.click();document.body.removeChild(a);
    }
    setTimeout(()=>URL.revokeObjectURL(url),10000);
  }catch(e){console.error('export failed',e);}
}

// ── exportTeacherHtml ─────────────────────────────────────────────────────────
function exportTeacherHtml(schoolName,classes,teachers,base,changes){
  const openHtml=(html,filename)=>{
    try{
      const blob=new Blob([html],{type:'text/html;charset=utf-8'});
      const url=URL.createObjectURL(blob);
      const w=window.open(url,'_blank','noopener');
      if(!w){const a=document.createElement('a');a.href=url;a.download=filename;a.style.display='none';document.body.appendChild(a);a.click();document.body.removeChild(a);}
      setTimeout(()=>URL.revokeObjectURL(url),10000);
    }catch(e){console.error('exportTeacherHtml failed',e);}
  };
  const SC=JSON.stringify({"国語":"#FDE8E8","数学":"#DBEAFE","英語":"#D1FAE5","理科":"#DCFCE7","社会":"#FEF9C3","音楽":"#EDE9FE","美術":"#FEE2CC","体育":"#BAE6FD","技術":"#CCFBF1","家庭":"#FCE7F3","道徳":"#E0F2FE","学活":"#F3E8FF","総合":"#FEF3C7","生活":"#ECFDF5","自立":"#E0F7FA","図工":"#FFFBEB"});
  const p=[];
  p.push('<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8">');
  p.push('<meta name="viewport" content="width=device-width,initial-scale=1">');
  p.push('<title>'+schoolName+' 教員時間割</title>');
  p.push('<style>');
  p.push('body{margin:0;font-family:\'Hiragino Sans\',sans-serif;background:#EFF6FF;}');
  p.push('.hdr{background:#1D4ED8;color:white;padding:0 14px;display:flex;align-items:center;height:52px;gap:8px;flex-wrap:wrap;}');
  p.push('.hdr h1{font-size:15px;margin:0;flex:1;}');
  p.push('.tbar{display:flex;gap:0;border-radius:5px;overflow:hidden;border:1px solid rgba(255,255,255,0.4);}');
  p.push('.tbtn{padding:5px 12px;border:none;cursor:pointer;font-size:12px;color:white;background:transparent;}');
  p.push('.mbar{display:flex;border-radius:5px;overflow:hidden;border:1px solid rgba(255,255,255,0.4);}');
  p.push('.mbtn{padding:5px 10px;border:none;cursor:pointer;font-size:12px;color:white;}');
  p.push('.wbtn{padding:4px 10px;border:none;background:rgba(255,255,255,0.2);color:white;border-radius:4px;cursor:pointer;font-size:12px;}');
  p.push('.sel{background:white;border-bottom:2px solid #BFDBFE;padding:8px 14px;display:flex;flex-wrap:wrap;gap:6px;align-items:center;}');
  p.push('.sbtn{padding:4px 12px;border:1.5px solid #93C5FD;border-radius:16px;cursor:pointer;font-size:12px;background:white;color:#1D4ED8;}');
  p.push('.sbtn.on{background:#1D4ED8;color:white;border-color:#1D4ED8;font-weight:700;}');
  p.push('.cnt{padding:14px;overflow-x:auto;}');
  p.push('table{border-collapse:collapse;}th,td{border:1px solid #BFDBFE;text-align:center;vertical-align:middle;}');
  p.push('.ph{background:#1D4ED8;color:white;padding:6px 8px;min-width:40px;font-size:12px;font-weight:700;}');
  p.push('.dh{background:#EFF6FF;color:#1E3A8A;padding:6px 8px;font-size:12px;font-weight:700;white-space:pre;}');
  p.push('.sj{font-size:15px;font-weight:700;color:#1E293B;margin-bottom:2px;}');
  p.push('.tc{font-size:10px;color:#475569;}.cc{font-size:10px;color:#6D28D9;}.jt{font-size:9px;color:#6366F1;}');
  p.push('.bc{font-size:9px;font-weight:700;color:#B45309;margin-bottom:1px;}.bs{font-size:9px;font-weight:700;color:#DC2626;margin-bottom:1px;}');
  p.push('.wn{display:none;align-items:center;gap:6px;}');
  p.push('.leg{padding:0 14px 14px;display:flex;gap:8px;font-size:11px;color:#6B7280;}');
  p.push('.lc{background:#FEF3C7;color:#B45309;padding:1px 8px;border-radius:3px;border:1px solid #FDE68A;font-weight:700;}');
  p.push('.ls{background:#FEE2E2;color:#DC2626;padding:1px 8px;border-radius:3px;border:1px solid #FECACA;font-weight:700;}');
  p.push('</style></head><body>');
  p.push('<div class="hdr">');
  p.push('<span style="font-size:20px">📚</span><h1>'+schoolName+' 教員ビュー</h1>');
  p.push('<div class="tbar">');
  p.push('<button class="tbtn" id="tc" onclick="setTab(\'class\')">🏫 学級別</button>');
  p.push('<button class="tbtn" id="tt" onclick="setTab(\'teacher\')">👩‍🏫 授業者別</button>');
  p.push('<button class="tbtn" id="ta" onclick="setTab(\'all\')">📋 授業者一覧</button>');
  p.push('</div>');
  p.push('<div class="mbar">');
  p.push('<button class="mbtn" id="bb" onclick="setM(false)" style="background:rgba(255,255,255,0.3);font-weight:700">基本</button>');
  p.push('<button class="mbtn" id="bw" onclick="setM(true)">週間変更</button>');
  p.push('</div>');
  p.push('<span class="wn" id="wn">');
  p.push('<button class="wbtn" onclick="sh(-7)">◀</button>');
  p.push('<span id="wl" style="font-size:12px;font-weight:700;min-width:180px;text-align:center"></span>');
  p.push('<button class="wbtn" onclick="sh(7)">▶</button>');
  p.push('<button class="wbtn" style="font-size:11px" onclick="gt()">今週</button>');
  p.push('</span>');
  p.push('<span style="font-size:11px;background:rgba(255,255,255,0.15);border-radius:4px;padding:3px 8px">👀 閲覧専用</span>');
  p.push('</div>');
  p.push('<div class="sel" id="sel"></div>');
  p.push('<div class="cnt" id="tb"></div>');
  p.push('<div class="leg"><span class="lc">変更</span><span class="ls">補欠</span><span>— 空きコマ</span></div>');
  const sc=[
    'var B='+JSON.stringify(base)+';',
    'var C='+JSON.stringify(changes)+';',
    'var T='+JSON.stringify(teachers.map(t=>({id:t.id,name:t.name})))+';',
    'var CLS='+JSON.stringify(classes.map(c=>({id:c.id,name:c.name})))+';',
    'var SC='+SC+';',
    'var tab="class",dm=false,selCls=CLS.length?CLS[0].id:"",selTid=T.length?T[0].id:"",selDay=0;',
    'var DAYS=["月","火","水","木","金"];',
    'function ls(d){return d.getFullYear()+"-"+("0"+(d.getMonth()+1)).slice(-2)+"-"+("0"+d.getDate()).slice(-2);}',
    'function td(){return ls(new Date());}',
    'function ad(ds,n){var d=new Date(ds+"T00:00:00");d.setDate(d.getDate()+n);return ls(d);}',
    'function gm(ds){var d=new Date(ds+"T00:00:00"),w=d.getDay();d.setDate(d.getDate()+(w===0?-6:1-w));return ls(d);}',
    'function fw(m){var s=new Date(m+"T00:00:00"),e=new Date(ad(m,4)+"T00:00:00");return s.getFullYear()+"年 "+(s.getMonth()+1)+"/"+s.getDate()+"（月）〜"+(e.getMonth()+1)+"/"+e.getDate()+"（金）";}',
    'function dw(ds){var w=new Date(ds+"T00:00:00").getDay();return w>=1&&w<=5?DAYS[w-1]:null;}',
    'function md(ds){var d=new Date(ds+"T00:00:00");return(d.getMonth()+1)+"/"+d.getDate();}',
    'var wk=gm(td());',
    'function tn(id){var t=T.find(function(x){return x.id===id;});return t?t.name:id;}',
    'function cn(id){var c=CLS.find(function(x){return x.id===id;});return c?c.name:id;}',
    'function gcol(s){return SC[s]||"#F8F8F8";}',
    'function getCols(){',
    '  if(dm){return Array.from({length:5},function(_,i){var dt=ad(wk,i),d=new Date(dt+"T00:00:00");return{label:DAYS[i]+"\\n"+(d.getMonth()+1)+"/"+d.getDate(),date:dt,di:i};});}',
    '  return DAYS.map(function(d,i){return{label:d+"曜日",di:i};});',
    '}',
    'function gec(col,p,cid){',
    '  if(dm){var ch=C.find(function(c){return c.date===col.date&&c.period===p&&(c.classIds||[]).indexOf(cid)>=0;});',
    '    if(ch)return Object.assign({},ch,{_ch:true});',
    '    var dv=dw(col.date);if(!dv)return null;',
    '    return B.find(function(e){return e.day===dv&&e.period===p&&(e.classIds||[]).indexOf(cid)>=0;})||null;}',
    '  return B.find(function(e){return e.day===DAYS[col.di]&&e.period===p&&(e.classIds||[]).indexOf(cid)>=0;})||null;',
    '}',
    'function getT(col,p,tid){',
    '  if(dm){var ch=C.find(function(c){return c.date===col.date&&c.period===p&&(c.teacherIds||[]).indexOf(tid)>=0;});',
    '    if(ch)return Object.assign({},ch,{_ch:true});',
    '    var dv=dw(col.date);if(!dv)return null;',
    '    return B.find(function(e){return e.day===dv&&e.period===p&&(e.teacherIds||[]).indexOf(tid)>=0;})||null;}',
    '  return B.find(function(e){return e.day===DAYS[col.di]&&e.period===p&&(e.teacherIds||[]).indexOf(tid)>=0;})||null;',
    '}',
    'function cellH(e,shT,shC){',
    '  if(!e)return "<span style=\'color:#E2E8F0;font-size:18px\'>—</span>";',
    '  if(e.isBlocked)return "<span style=\'color:#D1D5DB;font-size:18px\'>—</span>";',
    '  var h="";',
    '  if(e._ch)h+="<div class=\'"+(e.isSubst?"bs":"bc")+"\'>"+(e.isSubst?"補欠":"変更")+"</div>";',
    '  h+="<div class=\'sj\'>"+e.subject+"</div>";',
    '  if(shT)h+="<div class=\'tc\'>"+(e.teacherIds||[]).map(tn).join("・")+"先生</div>";',
    '  if(shC)h+="<div class=\'cc\'>"+(e.classIds||[]).map(cn).join("・")+"</div>";',
    '  if((e.classIds||[]).length>1)h+="<div class=\'jt\'>合同</div>";',
    '  return h;',
    '}',
    'function ctd(e,shT,shC){',
    '  var bg=e?e.isBlocked?"#F9FAFB":gcol(e.subject):"#FAFAFA";',
    '  var bl=e&&e._ch?"4px solid "+(e.isSubst?"#EF4444":"#F59E0B"):"1px solid #BFDBFE";',
    '  return "<td style=\'background:"+bg+";border:1px solid #BFDBFE;border-left:"+bl+";padding:6px;height:68px;min-width:88px;vertical-align:middle;text-align:center\'>"+cellH(e,shT,shC)+"</td>";',
    '}',
    'function render(){',
    '  var cols=getCols();',
    '  var bb=document.getElementById("bb"),bw=document.getElementById("bw");',
    '  bb.style.background=dm?"transparent":"rgba(255,255,255,0.3)";bb.style.fontWeight=dm?"400":"700";',
    '  bw.style.background=dm?"rgba(255,255,255,0.3)":"transparent";bw.style.fontWeight=dm?"700":"400";',
    '  document.getElementById("wn").style.display=dm?"flex":"none";',
    '  document.getElementById("wl").textContent=fw(wk);',
    '  ["tc","tt","ta"].forEach(function(id,i){',
    '    var el=document.getElementById(id),v=["class","teacher","all"][i];',
    '    el.style.background=tab===v?"rgba(255,255,255,0.3)":"transparent";',
    '    el.style.fontWeight=tab===v?"700":"400";',
    '  });',
    '  var sel=document.getElementById("sel"),selH="";',
    '  if(tab==="class"){CLS.forEach(function(c){selH+="<button class=\'sbtn"+(selCls===c.id?" on":"")+"\'  data-type=\'cls\' data-id=\'"+c.id+"\'>"+c.name+"</button>";});}',
    '  else if(tab==="teacher"){T.forEach(function(t){selH+="<button class=\'sbtn"+(selTid===t.id?" on":"")+"\'  data-type=\'tid\' data-id=\'"+t.id+"\'>"+t.name+"先生</button>";});}',
    '  else{DAYS.forEach(function(d,i){var lbl=dm?d+"\\n"+md(ad(wk,i)):d+"曜";selH+="<button class=\'sbtn"+(selDay===i?" on":"")+"\'  data-type=\'day\' data-id=\'"+i+"\' style=\'white-space:pre\'>"+lbl+"</button>";});}',
    '  sel.innerHTML=selH;',
    '  sel.onclick=function(ev){var b=ev.target;while(b&&b.tagName!=="BUTTON")b=b.parentElement;if(!b||!b.dataset.type)return;if(b.dataset.type==="cls")selCls=b.dataset.id;else if(b.dataset.type==="tid")selTid=b.dataset.id;else selDay=parseInt(b.dataset.id);render();};',
    '  var h="<div style=\'overflow-x:auto\'><table style=\'border-collapse:collapse\'><thead><tr><th class=\'ph\'>時限</th>";',
    '  if(tab==="all"){T.forEach(function(t){h+="<th class=\'dh\'>"+t.name+"先生</th>";});}',
    '  else{cols.forEach(function(c){h+="<th class=\'dh\'>"+c.label+"</th>";});}',
    '  h+="</tr></thead><tbody>";',
    '  for(var pr=1;pr<=6;pr++){',
    '    h+="<tr><td class=\'ph\' style=\'font-size:11px\'>"+pr+"限</td>";',
    '    if(tab==="class"){cols.forEach(function(col){h+=ctd(gec(col,pr,selCls),true,false);});}',
    '    else if(tab==="teacher"){cols.forEach(function(col){h+=ctd(getT(col,pr,selTid),false,true);});}',
    '    else{var col=cols[selDay]||cols[0];T.forEach(function(t){h+=ctd(getT(col,pr,t.id),false,true);});}',
    '    h+="</tr>";',
    '  }',
    '  h+="</tbody></table></div>";',
    '  document.getElementById("tb").innerHTML=h;',
    '}',
    'function setTab(v){tab=v;render();}',
    'function setM(v){dm=v;render();}',
    'function sh(n){wk=ad(wk,n);render();}',
    'function gt(){wk=gm(td());render();}',
    'render();',
  ].join('\n');
  p.push('<script>'+sc+'<\/script></body></html>');
  openHtml(p.join(''),schoolName+'_教員時間割.html');
}

// ── StudentView ───────────────────────────────────────────────────────────────
function StudentView({schoolName,classes,teachers,base,changes,isLocked,lockedClassId,publishedAt,onExit}){
  const DAYS_SV=["月","火","水","木","金"],PERIODS_SV=[1,2,3,4,5,6];
  const localStrSV=d=>`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
  const todaySV=()=>localStrSV(new Date());
  const addDSV=(ds,n)=>{const d=new Date(ds+"T00:00:00");d.setDate(d.getDate()+n);return localStrSV(d);};
  const getMonSV=ds=>{const d=new Date(ds+"T00:00:00"),w=d.getDay();d.setDate(d.getDate()+(w===0?-6:1-w));return localStrSV(d);};
  const fmtWeekSV=m=>{const s=new Date(m+"T00:00:00"),e=new Date(addDSV(m,4)+"T00:00:00");return`${s.getFullYear()}年 ${s.getMonth()+1}/${s.getDate()}（月）〜${e.getMonth()+1}/${e.getDate()}（金）`;};
  const fmtMDSV=ds=>{const d=new Date(ds+"T00:00:00");return`${d.getMonth()+1}/${d.getDate()}`;};
  const dowOfSV=ds=>{const w=new Date(ds+"T00:00:00").getDay();return(w>=1&&w<=5)?DAYS_SV[w-1]:null;};
  const cnSV=id=>classes.find(c=>c.id===id)?.name||id;
  const tnSV=id=>(teachers||[]).find(t=>t.id===id)?.name||id;
  const SC_SV={"国語":"#FDE8E8","数学":"#DBEAFE","英語":"#D1FAE5","理科":"#DCFCE7","社会":"#FEF9C3","音楽":"#EDE9FE","美術":"#FEE2CC","体育":"#BAE6FD","技術":"#CCFBF1","家庭":"#FCE7F3","道徳":"#E0F2FE","学活":"#F3E8FF","総合":"#FEF3C7","生活":"#ECFDF5","自立":"#E0F7FA","図工":"#FFFBEB"};
  const gcSV=s=>SC_SV[s]||"#F8F8F8";

  const[selCls,setSelCls]=React.useState(lockedClassId||classes[0]?.id||"");
  const[dm,setDm]=React.useState(false);
  const[wk,setWk]=React.useState(getMonSV(todaySV()));
  const[showUrls,setShowUrls]=React.useState(false);

  const dates=Array.from({length:5},(_,i)=>addDSV(wk,i));
  const cols=dm?dates.map((dt,i)=>({label:DAYS_SV[i]+"\n"+fmtMDSV(dt),date:dt,di:i}))
               :DAYS_SV.map((d,i)=>({label:d+"曜日",di:i}));

  const getEntry=(col,p)=>{
    if(dm){
      const dt=col.date;
      const chg=changes.find(c=>c.date===dt&&c.period===p&&(c.classIds||[]).includes(selCls));
      if(chg)return{...chg,_ch:true};
      const dow=dowOfSV(dt);if(!dow)return null;
      return base.find(e=>e.day===dow&&e.period===p&&(e.classIds||[]).includes(selCls))||null;
    }
    return base.find(e=>e.day===DAYS_SV[col.di]&&e.period===p&&(e.classIds||[]).includes(selCls))||null;
  };

  const PTHs={padding:"7px 8px",background:"#1E5F3A",color:"white",fontWeight:700,textAlign:"center",fontSize:12,minWidth:42};
  const THs={padding:"8px 6px",background:"#F0FDF4",fontWeight:700,textAlign:"center",fontSize:12,minWidth:100,border:"1px solid #BBF7D0",color:"#14532D",whiteSpace:"pre"};

  return(
    <div style={{minHeight:"100vh",background:"#F0FDF4",fontFamily:"'Noto Sans JP','Hiragino Sans',sans-serif"}}>
      <div style={{background:"#15803D",color:"white",padding:"0 14px",display:"flex",alignItems:"center",height:52,gap:8,flexWrap:"nowrap"}}>
        <span style={{fontSize:20}}>🎒</span>
        <span style={{fontWeight:700,fontSize:15,flex:1,whiteSpace:"nowrap"}}>{schoolName} 時間割</span>
        <div style={{display:"flex",borderRadius:5,overflow:"hidden",border:"1px solid rgba(255,255,255,0.4)"}}>
          {[{v:false,l:"基本"},{v:true,l:"週間変更"}].map(({v,l})=>(
            <button key={String(v)} onClick={()=>setDm(v)}
              style={{padding:"4px 10px",border:"none",cursor:"pointer",fontSize:11,fontWeight:dm===v?700:400,
                background:dm===v?"rgba(255,255,255,0.3)":"transparent",color:"white"}}>{l}</button>
          ))}
        </div>
        {dm&&<>
          <button onClick={()=>setWk(addDSV(wk,-7))} style={{background:"rgba(255,255,255,0.2)",border:"none",color:"white",padding:"4px 10px",borderRadius:4,cursor:"pointer",fontSize:14}}>◀</button>
          <span style={{fontSize:12,fontWeight:700,whiteSpace:"nowrap"}}>{fmtWeekSV(wk)}</span>
          <button onClick={()=>setWk(addDSV(wk,7))} style={{background:"rgba(255,255,255,0.2)",border:"none",color:"white",padding:"4px 10px",borderRadius:4,cursor:"pointer",fontSize:14}}>▶</button>
          <button onClick={()=>setWk(getMonSV(todaySV()))} style={{background:"rgba(255,255,255,0.15)",border:"1px solid rgba(255,255,255,0.3)",color:"white",padding:"3px 8px",borderRadius:4,cursor:"pointer",fontSize:11}}>今週</button>
        </>}
        {!isLocked&&<>
          <button onClick={()=>setShowUrls(s=>!s)}
            style={{background:"rgba(255,255,255,0.2)",border:"1px solid rgba(255,255,255,0.4)",color:"white",padding:"4px 10px",borderRadius:4,cursor:"pointer",fontSize:11,fontWeight:700}}>
            📥 HTML書き出し
          </button>
          <button onClick={onExit}
            style={{background:"rgba(255,255,255,0.25)",border:"1px solid rgba(255,255,255,0.4)",color:"white",padding:"4px 10px",borderRadius:4,cursor:"pointer",fontSize:11,fontWeight:700}}>
            ✕ 管理者
          </button>
        </>}
      </div>

      {showUrls&&(
        <div style={{background:"#F0FFF4",borderBottom:"2px solid #BBF7D0",padding:"12px 14px"}}>
          <div style={{fontWeight:700,fontSize:13,color:"#15803D",marginBottom:4}}>📥 HTMLファイル書き出し</div>
          <div style={{fontSize:11,color:"#6B7280",marginBottom:10}}>
            ダウンロードしたHTMLファイルは<strong>ログイン不要</strong>で開けます。
          </div>
          <div style={{display:"flex",flexDirection:"column",gap:6}}>
            <div style={{display:"flex",alignItems:"center",gap:8,padding:"8px 12px",background:"white",borderRadius:6,border:"1px solid #D1FAE5"}}>
              <span style={{fontSize:12,fontWeight:700,color:"#374151",flex:1}}>全学級共通（学級選択付き）</span>
              <button onClick={()=>exportHtml(schoolName,classes,teachers,base,changes,null,'全学級共通')}
                style={{padding:"5px 14px",background:"#15803D",color:"white",border:"none",borderRadius:5,cursor:"pointer",fontSize:12,fontWeight:700}}>
                📥 ダウンロード
              </button>
            </div>
            {classes.map(c=>(
              <div key={c.id} style={{display:"flex",alignItems:"center",gap:8,padding:"8px 12px",background:"white",borderRadius:6,border:"1px solid #D1FAE5"}}>
                <span style={{fontSize:12,fontWeight:700,color:"#1E293B",flex:1}}>{c.name}専用</span>
                <span style={{fontSize:11,color:"#9CA3AF"}}>クラス固定・切替不可</span>
                <button onClick={()=>exportHtml(schoolName,classes,teachers,base,changes,c.id)}
                  style={{padding:"5px 14px",background:"#15803D",color:"white",border:"none",borderRadius:5,cursor:"pointer",fontSize:12,fontWeight:700}}>
                  📥 ダウンロード
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {!lockedClassId&&(
        <div style={{background:"white",borderBottom:"2px solid #BBF7D0",padding:"8px 14px",display:"flex",alignItems:"center",gap:6,flexWrap:"wrap"}}>
          <span style={{fontSize:12,fontWeight:700,color:"#15803D",marginRight:4}}>クラス：</span>
          {classes.map(c=>(
            <button key={c.id} onClick={()=>setSelCls(c.id)}
              style={{padding:"4px 14px",border:"1.5px solid",borderRadius:16,cursor:"pointer",fontSize:12,
                borderColor:selCls===c.id?"#15803D":"#86EFAC",
                background:selCls===c.id?"#15803D":"white",
                color:selCls===c.id?"white":"#15803D",fontWeight:selCls===c.id?700:400}}>
              {c.name}
            </button>
          ))}
        </div>
      )}
      {lockedClassId&&(
        <div style={{background:"#DCFCE7",borderBottom:"1px solid #BBF7D0",padding:"8px 14px",fontSize:14,fontWeight:700,color:"#15803D"}}>
          🏫 {cnSV(lockedClassId)} の時間割
        </div>
      )}

      <div style={{padding:"14px",overflowX:"auto"}}>
        <table style={{borderCollapse:"collapse"}}>
          <thead>
            <tr>
              <th style={PTHs}>時限</th>
              {cols.map((c,i)=><th key={i} style={THs}>{c.label}</th>)}
            </tr>
          </thead>
          <tbody>
            {PERIODS_SV.map(p=>(
              <tr key={p}>
                <td style={{...PTHs,fontSize:11}}>{p}限</td>
                {cols.map((col,i)=>{
                  const e=getEntry(col,p);
                  const isBlk=e?.isBlocked;
                  return(
                    <td key={i} style={{padding:"10px 8px",border:"1px solid #D1FAE5",
                      borderLeft:e?._ch?`4px solid ${e.isSubst?"#EF4444":"#F59E0B"}`:"1px solid #D1FAE5",
                      background:isBlk?"#F9FAFB":e?gcSV(e.subject):"#FAFAFA",
                      textAlign:"center",verticalAlign:"middle",minWidth:100,height:72}}>
                      {isBlk?<span style={{color:"#D1D5DB",fontSize:20}}>—</span>
                      :e?(
                        <div>
                          {e._ch&&<div style={{fontSize:10,fontWeight:700,color:e.isSubst?"#DC2626":"#B45309",marginBottom:2}}>{e.isSubst?"補欠":"変更"}</div>}
                          <div style={{fontWeight:700,fontSize:17,color:"#1E293B",marginBottom:3}}>{e.subject}</div>
                          <div style={{fontSize:12,color:"#475569"}}>{(e.teacherIds||[]).map(tid=>tnSV(tid)).join("・")}先生</div>
                          {(e.classIds||[]).length>1&&<div style={{fontSize:10,color:"#6366F1",marginTop:2}}>合同授業</div>}
                          {e.note&&<div style={{fontSize:10,color:"#9CA3AF",marginTop:2}}>📝{e.note}</div>}
                        </div>
                      ):<span style={{color:"#E2E8F0",fontSize:20}}>—</span>}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
        <div style={{marginTop:10,display:"flex",gap:8,fontSize:11,color:"#6B7280"}}>
          <span style={{background:"#FEF3C7",color:"#B45309",padding:"1px 8px",borderRadius:3,border:"1px solid #FDE68A",fontWeight:700}}>変更</span>
          <span style={{background:"#FEE2E2",color:"#DC2626",padding:"1px 8px",borderRadius:3,border:"1px solid #FECACA",fontWeight:700}}>補欠</span>
          <span>— 空き/表示なし</span>
        </div>
        {isLocked&&<div style={{marginTop:16,padding:"10px 14px",background:"#DCFCE7",borderRadius:8,fontSize:11,color:"#15803D",border:"1px solid #BBF7D0"}}>
          🔒 閲覧専用ページです。
          {publishedAt&&<span style={{marginLeft:8,color:"#6B7280"}}>最終更新：{(()=>{const d=new Date(publishedAt);return`${d.getFullYear()}/${d.getMonth()+1}/${d.getDate()} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;})()}</span>}
        </div>}
      </div>
    </div>
  );
}

// ── TeacherView ───────────────────────────────────────────────────────────────
function TeacherView({schoolName,classes,teachers,base,changes,publishedAt,onExit,onLogout}){
  const DAYS_TV=["月","火","水","木","金"],PERIODS_TV=[1,2,3,4,5,6];
  const localStrTV=d=>d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0")+"-"+String(d.getDate()).padStart(2,"0");
  const todayTV=()=>localStrTV(new Date());
  const addDTV=(ds,n)=>{const d=new Date(ds+"T00:00:00");d.setDate(d.getDate()+n);return localStrTV(d);};
  const getMonTV=ds=>{const d=new Date(ds+"T00:00:00"),w=d.getDay();d.setDate(d.getDate()+(w===0?-6:1-w));return localStrTV(d);};
  const fmtWeekTV=m=>{const s=new Date(m+"T00:00:00"),e=new Date(addDTV(m,4)+"T00:00:00");return s.getFullYear()+"年 "+(s.getMonth()+1)+"/"+s.getDate()+"（月）〜"+(e.getMonth()+1)+"/"+e.getDate()+"（金）";};
  const fmtMDTV=ds=>{const d=new Date(ds+"T00:00:00");return(d.getMonth()+1)+"/"+d.getDate();};
  const dowOfTV=ds=>{const w=new Date(ds+"T00:00:00").getDay();return(w>=1&&w<=5)?DAYS_TV[w-1]:null;};
  const cn=id=>classes.find(c=>c.id===id)?.name||id;
  const tn=id=>(teachers||[]).find(t=>t.id===id)?.name||id;
  const gcTV=s=>({"国語":"#FDE8E8","数学":"#DBEAFE","英語":"#D1FAE5","理科":"#DCFCE7","社会":"#FEF9C3","音楽":"#EDE9FE","美術":"#FEE2CC","体育":"#BAE6FD","技術":"#CCFBF1","家庭":"#FCE7F3","道徳":"#E0F2FE","学活":"#F3E8FF","総合":"#FEF3C7","生活":"#ECFDF5","自立":"#E0F7FA","図工":"#FFFBEB"})[s]||"#F8F8F8";

  const[tab,setTab]=React.useState("class");
  const[dm,setDm]=React.useState(false);
  const[wk,setWk]=React.useState(getMonTV(todayTV()));
  const[selCls,setSelCls]=React.useState(classes[0]?.id||"");
  const[selTid,setSelTid]=React.useState(teachers[0]?.id||"");
  const[selDay,setSelDay]=React.useState(0);

  const dates=Array.from({length:5},(_,i)=>addDTV(wk,i));
  const cols=dm
    ?dates.map((dt,i)=>({label:DAYS_TV[i]+"\n"+fmtMDTV(dt),date:dt,di:i}))
    :DAYS_TV.map((d,i)=>({label:d+"曜日",di:i}));

  const getEntryByCls=(col,p,cid)=>{
    if(dm){
      const chgs=changes.filter(c=>c.date===col.date&&c.period===p&&(c.classIds||[]).includes(cid));
      // isBlocked（行事・欠課）を優先
      const blocked=chgs.find(c=>c.isBlocked);
      if(blocked)return{...blocked,_ch:true};
      const lesson=chgs.find(c=>!c._removed);
      if(lesson)return{...lesson,_ch:true};
      if(chgs.length>0)return null; // _removedのみ
      const dow=dowOfTV(col.date);if(!dow)return null;
      return base.find(e=>e.day===dow&&e.period===p&&(e.classIds||[]).includes(cid))||null;
    }
    return base.find(e=>e.day===DAYS_TV[col.di]&&e.period===p&&(e.classIds||[]).includes(cid))||null;
  };

  const getEntryByTid=(col,p,tid)=>{
    if(dm){
      const chg=changes.find(c=>c.date===col.date&&c.period===p&&(c.teacherIds||[]).includes(tid));
      if(chg)return{...chg,_ch:true};
      const dow=dowOfTV(col.date);if(!dow)return null;
      return base.find(e=>e.day===dow&&e.period===p&&(e.teacherIds||[]).includes(tid))||null;
    }
    return base.find(e=>e.day===DAYS_TV[col.di]&&e.period===p&&(e.teacherIds||[]).includes(tid))||null;
  };

  const cellSt=e=>({
    border:"1px solid #DBEAFE",padding:"6px",verticalAlign:"middle",textAlign:"center",
    minWidth:88,height:68,
    background:e?e.isBlocked?"#F9FAFB":gcTV(e.subject):"#FAFAFA",
    borderLeft:e&&e._ch?"4px solid "+(e.isSubst?"#EF4444":"#F59E0B"):"1px solid #DBEAFE",
  });

  const cellBody=e=>{
    if(!e)return <span style={{color:"#E2E8F0",fontSize:18}}>—</span>;
    if(e.isBlocked)return(
      <div>
        <div style={{display:"inline-flex",alignItems:"center",gap:3,background:"rgba(55,65,81,0.85)",color:"white",borderRadius:4,padding:"2px 7px",fontSize:10,fontWeight:700}}>
          🚫 {e.note||"空き"}
        </div>
      </div>
    );
    return(
      <div>
        {e._ch&&<div style={{fontSize:9,fontWeight:700,color:e.isSubst?"#DC2626":"#B45309",marginBottom:1}}>{e.isSubst?"補欠":"変更"}</div>}
        <div style={{fontSize:14,fontWeight:700,color:"#1E293B",marginBottom:2}}>{e.subject}</div>
        <div style={{fontSize:10,color:"#475569"}}>{(e.teacherIds||[]).map(tn).join("・")}先生</div>
        <div style={{fontSize:10,color:"#6D28D9"}}>{(e.classIds||[]).map(cn).join("・")}</div>
        {(e.classIds||[]).length>1&&<div style={{fontSize:9,color:"#6366F1",marginTop:1}}>合同</div>}
      </div>
    );
  };

  const tbSt=on=>({padding:"6px 14px",border:"none",cursor:"pointer",fontSize:12,
    background:on?"#1D4ED8":"#F1F5F9",color:on?"white":"#64748B",fontWeight:on?700:400});

  return(
    <div style={{minHeight:"100vh",background:"#EFF6FF",fontFamily:"'Noto Sans JP','Hiragino Sans',sans-serif"}}>
      <div style={{background:"#1D4ED8",color:"white",padding:"0 14px",display:"flex",alignItems:"center",height:50,gap:10}}>
        <span style={{fontSize:20}}>📚</span>
        <span style={{fontWeight:700,fontSize:15,flex:1}}>{schoolName} 時間割 — 教員ビュー</span>
        <span style={{fontSize:12,background:"rgba(255,255,255,0.15)",borderRadius:4,padding:"3px 10px"}}>👀 閲覧専用</span>
        {publishedAt&&<span style={{fontSize:11,color:"rgba(255,255,255,0.7)"}}>最終更新：{(()=>{const d=new Date(publishedAt);return`${d.getFullYear()}/${d.getMonth()+1}/${d.getDate()} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;})()}</span>}
        <button onClick={()=>exportTeacherHtml(schoolName,classes,teachers,base,changes)}
          style={{background:"rgba(255,255,255,0.2)",border:"1px solid rgba(255,255,255,0.4)",color:"white",padding:"4px 12px",borderRadius:4,cursor:"pointer",fontSize:12,fontWeight:700}}>
          📥 HTML書き出し
        </button>
        {onExit&&<button onClick={onExit}
          style={{background:"rgba(255,255,255,0.2)",border:"1px solid rgba(255,255,255,0.4)",color:"white",padding:"4px 12px",borderRadius:4,cursor:"pointer",fontSize:12}}>
          ✕ 管理者に戻る
        </button>}
        {onLogout&&<button onClick={onLogout}
          style={{background:"rgba(255,255,255,0.2)",border:"1px solid rgba(255,255,255,0.4)",color:"white",padding:"4px 12px",borderRadius:4,cursor:"pointer",fontSize:12}}>
          🔓 ログアウト
        </button>}
      </div>
      <div style={{background:"white",borderBottom:"1px solid #BFDBFE",padding:"8px 14px",display:"flex",alignItems:"center",gap:10,flexWrap:"wrap"}}>
        <div style={{display:"flex",borderRadius:6,overflow:"hidden",border:"1.5px solid #BFDBFE"}}>
          {[{v:"class",l:"🏫 学級別"},{v:"teacher",l:"👩‍🏫 授業者別"},{v:"all",l:"📋 授業者一覧"}].map(({v,l})=>(
            <button key={v} onClick={()=>setTab(v)} style={tbSt(tab===v)}>{l}</button>
          ))}
        </div>
        <div style={{display:"flex",borderRadius:6,overflow:"hidden",border:"1.5px solid #BFDBFE"}}>
          {[{v:false,l:"📋 基本"},{v:true,l:"📅 週間変更"}].map(({v,l})=>(
            <button key={String(v)} onClick={()=>setDm(v)} style={tbSt(dm===v)}>{l}</button>
          ))}
        </div>
        {dm&&(
          <div style={{display:"flex",alignItems:"center",gap:6}}>
            <button onClick={()=>setWk(w=>addDTV(w,-7))} style={{padding:"3px 8px",border:"1.5px solid #BFDBFE",borderRadius:16,cursor:"pointer",fontSize:12,background:"white"}}>◀</button>
            <span style={{fontSize:12,fontWeight:700,minWidth:220,textAlign:"center"}}>{fmtWeekTV(wk)}</span>
            <button onClick={()=>setWk(w=>addDTV(w,7))} style={{padding:"3px 8px",border:"1.5px solid #BFDBFE",borderRadius:16,cursor:"pointer",fontSize:12,background:"white"}}>▶</button>
            <button onClick={()=>setWk(getMonTV(todayTV()))} style={{padding:"3px 8px",border:"1.5px solid #BFDBFE",borderRadius:16,cursor:"pointer",fontSize:11,background:"white"}}>今週</button>
          </div>
        )}
      </div>
      <div style={{maxWidth:1280,margin:"0 auto",padding:16}}>
        {tab==="class"&&(
          <div>
            <div style={{display:"flex",flexWrap:"wrap",gap:6,marginBottom:12}}>
              {classes.map(c=>(
                <button key={c.id} onClick={()=>setSelCls(c.id)} style={chip(selCls===c.id,"#1D4ED8")}>{c.name}</button>
              ))}
            </div>
            <div style={{overflowX:"auto",position:"relative"}}>
              <table style={{borderCollapse:"collapse"}}>
                <thead>
                  <tr>
                    <th style={{...PTH,background:"#1D4ED8",minWidth:36,position:"sticky",left:0,zIndex:3}}>時限</th>
                    {cols.map((c,i)=><th key={i} style={TH}>{c.label}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {PERIODS_TV.map(p=>(
                    <tr key={p}>
                      <td style={{...PTH,background:"#1D4ED8",fontSize:11,position:"sticky",left:0,zIndex:2}}>{p}限</td>
                      {cols.map((col,ci)=>(
                        <td key={ci} style={cellSt(getEntryByCls(col,p,selCls))}>
                          {cellBody(getEntryByCls(col,p,selCls))}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
        {tab==="teacher"&&(
          <div>
            <div style={{display:"flex",flexWrap:"wrap",gap:6,marginBottom:12}}>
              {teachers.map(t=>(
                <button key={t.id} onClick={()=>setSelTid(t.id)} style={chip(selTid===t.id,"#1D4ED8")}>{t.name}先生</button>
              ))}
            </div>
            <div style={{overflowX:"auto",position:"relative"}}>
              <table style={{borderCollapse:"collapse"}}>
                <thead>
                  <tr>
                    <th style={{...PTH,background:"#1D4ED8",minWidth:36,position:"sticky",left:0,zIndex:3}}>時限</th>
                    {cols.map((c,i)=><th key={i} style={TH}>{c.label}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {PERIODS_TV.map(p=>(
                    <tr key={p}>
                      <td style={{...PTH,background:"#1D4ED8",fontSize:11,position:"sticky",left:0,zIndex:2}}>{p}限</td>
                      {cols.map((col,ci)=>(
                        <td key={ci} style={cellSt(getEntryByTid(col,p,selTid))}>
                          {cellBody(getEntryByTid(col,p,selTid))}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
        {tab==="all"&&(
          <div>
            <div style={{display:"flex",gap:4,marginBottom:12,flexWrap:"wrap"}}>
              {cols.map((c,i)=>(
                <button key={i} onClick={()=>setSelDay(i)}
                  style={{...chip(selDay===i,"#1D4ED8"),padding:"4px 16px",whiteSpace:"pre"}}>
                  {dm?DAYS_TV[i]+"\n"+fmtMDTV(dates[i]):DAYS_TV[i]+"曜"}
                </button>
              ))}
            </div>
            <div style={{overflowX:"auto",position:"relative"}}>
              <table style={{borderCollapse:"collapse"}}>
                <thead>
                  <tr>
                    <th style={{...PTH,background:"#1D4ED8",minWidth:36,position:"sticky",left:0,zIndex:3}}>時限</th>
                    {teachers.map(t=><th key={t.id} style={TH}>{t.name}先生</th>)}
                  </tr>
                </thead>
                <tbody>
                  {PERIODS_TV.map(p=>(
                    <tr key={p}>
                      <td style={{...PTH,background:"#1D4ED8",fontSize:11,position:"sticky",left:0,zIndex:2}}>{p}限</td>
                      {teachers.map(t=>{
                        const col=cols[selDay]||cols[0];
                        return(
                          <td key={t.id} style={cellSt(getEntryByTid(col,p,t.id))}>
                            {cellBody(getEntryByTid(col,p,t.id))}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
        <div style={{marginTop:12,display:"flex",gap:8,fontSize:11,color:"#6B7280"}}>
          <span style={{background:"#FEF3C7",color:"#B45309",padding:"1px 8px",borderRadius:3,border:"1px solid #FDE68A",fontWeight:700}}>変更</span>
          <span style={{background:"#FEE2E2",color:"#DC2626",padding:"1px 8px",borderRadius:3,border:"1px solid #FECACA",fontWeight:700}}>補欠</span>
          <span>— 空きコマ</span>
        </div>
      </div>
    </div>
  );
}

// ── ConflictDetail ────────────────────────────────────────────────────────────
function ConflictDetail({id,conflicts,tn,cn,dc,dowOf,dateMode}){
  const info=conflicts.get(id)||[];
  if(info.length===0)return <div style={{color:"#EF4444",fontSize:9,fontWeight:700}}>⚠重複</div>;
  // 【v8_7_27】行に「点滅の指定」を data-hoverspec(JSON) として埋め込む。
  //   点灯・消灯は最上位の pointermove が判定（mouseenter/leave は使わない＝取りこぼしゼロ）。
  const specOf=(c)=>{
    if(!dc)return null;
    return JSON.stringify({
      date:dc.date||null,
      day:dateMode?dowOf(dc.date||""):dc.day,
      period:dc.period,
      tids:(c.withEntry&&c.withEntry.teacherIds)||[],
      cids:(c.withEntry&&c.withEntry.classIds)||[],
    });
  };
  return(
    <div style={{color:"#EF4444",fontSize:9,fontWeight:700,lineHeight:1.4,marginTop:1}}>
      {info.map((c,i)=>{
        const spec=specOf(c);
        return(
        <div key={i} data-hoverspec={spec||undefined}
          style={{display:"flex",alignItems:"center",gap:2,flexWrap:"wrap",cursor:spec?"pointer":"default",borderRadius:3,padding:"0 1px"}}>
          <span>⚠</span>
          <span style={{color:"#DC2626"}}>
            {c.tid?`${tn(c.tid)}先生`:c.cid?`${cn(c.cid)}`:"重複"}
          </span>
          <span style={{color:"#9CA3AF",fontSize:8}}>←→</span>
          <span style={{color:"#B45309",fontWeight:600,textDecoration:spec?"underline dotted":"none"}}>
            {(c.withEntry.classIds||[]).map(x=>cn(x)).join("・")}{c.withEntry.subject}
            {c.withEntry.teacherIds&&c.withEntry.teacherIds.length>0&&` (${(c.withEntry.teacherIds||[]).map(x=>tn(x)).join("・")})`}
          </span>
        </div>
        );
      })}
    </div>
  );
}

function Sec({ label, sub, children }) {
  return (
    <div style={{ marginBottom: 13 }}>
      <div style={{ fontSize: 11, color: "#64748B", fontWeight: 700, marginBottom: 5 }}>
        {label}{" "}{sub && <span style={{ fontWeight: 400, color: "#94A3B8" }}>{sub}</span>}
      </div>
      {children}
    </div>
  );
}
function Pill({ on, onClick, children, extra }) {
  return (
    <button onClick={onClick} style={{ padding: "3px 10px", borderRadius: 5, fontSize: 12, cursor: "pointer", border: "1.5px solid", borderColor: on ? "#1E3A5F" : "#CBD5E1", background: on ? "#1E3A5F" : "white", color: on ? "white" : "#64748B", fontWeight: on ? 700 : 400, marginBottom: 3, marginRight: 3 }}>
      {children}{extra && <span style={{ fontSize: 9, color: "#F87171", marginLeft: 2 }}>{extra}</span>}
    </button>
  );
}

// ── Edit Modal ────────────────────────────────────────────────────────────────
function EditModal({modal,base,changes,teachers,classes,subjects,dateMode,onSaveBase,onSaveBaseKeepOpen,onAddBase,onDelBase,onSaveChange,onClearChange,onOpenPeriodPattern,onClose}){
  const cn=id=>classes.find(c=>c.id===id)?.name||id;
  const{entry,day,period,date,classIds:ctxCids,teacherId:ctxTid}=modal;
  // 空きセルから先生だけ指定で開いた場合は、その先生が最も多く担当する学級を初期値にする
  const teacherTopClass=(()=>{
    if(ctxCids?.[0]||entry?.classIds?.[0])return null; // 明示の学級があればそれを優先
    if(!ctxTid)return null;
    const t=teachers.find(x=>x.id===ctxTid);
    if(!t||!(t.asgn||[]).length)return null;
    const cnt={};
    (t.asgn||[]).forEach(a=>{if(a.c)cnt[a.c]=(cnt[a.c]||0)+1;});
    let best=null,bestN=0;
    Object.entries(cnt).forEach(([c,n])=>{if(n>bestN){bestN=n;best=c;}});
    return best&&classes.find(c=>c.id===best)?best:null;
  })();
  const initCid=ctxCids?.[0]||entry?.classIds?.[0]||teacherTopClass||"1-1";
  const baseEntry=base.find(e=>e.day===day&&e.period===period&&(e.classIds||[]).includes(initCid));
  const existChg=dateMode&&date?changes.find(c=>c.date===date&&c.period===period&&(c.classIds||[]).some(cid=>(entry?.classIds||[initCid]).includes(cid))):null;

  const isChangeMode=dateMode&&!!date;
  // 出張・欠課セルから開いた場合は補欠入力モードで開く
  const openedFromBlocked=!!entry?.isBlocked;
  const[tab,setTab]=useState(isChangeMode?"change":"base");
  const[isBlocked,setIsBlocked]=useState(openedFromBlocked?false:existChg?.isBlocked||false);
  const[blockReason,setBlockReason]=useState(existChg?.note||"欠課");
  const[isSubst,setIsSubst]=useState(openedFromBlocked?true:existChg?.isSubst||false);
  const[selSubj,setSelSubj]=useState(baseEntry?.subject||subjects?.[0]||"国語");
  const[selTids,setSelTids]=useState(openedFromBlocked?[]:(entry?.teacherIds||baseEntry?.teacherIds||[ctxTid||teachers[0]?.id].filter(Boolean)));
  const[selCids,setSelCids]=useState(entry?.classIds||baseEntry?.classIds||[initCid]);
  const[note,setNote]=useState(existChg?.isBlocked?"":existChg?.note||baseEntry?.note||"");
  const[altWeek,setAltWeek]=useState(baseEntry?.altWeek||""); // ""=毎週, "A"=A週のみ, "B"=B週のみ
  const[addingPair,setAddingPair]=React.useState(false); // B週ペア追加モード
  const[linkGroup,setLinkGroup]=useState(baseEntry?.linkGroup||null);

  // 連動リンク：同じ linkGroup を持つ他エントリ（同じ day+period）
  const linkedEntries=linkGroup
    ? base.filter(e=>e.linkGroup===linkGroup&&e.id!==(baseEntry?.id)&&e.day===day&&e.period===period)
    : [];
  // リンク候補：同じ day+period の他エントリ（未リンク or 別グループ）
  const linkCandidates=base.filter(e=>e.day===day&&e.period===period&&e.id!==(baseEntry?.id)&&!linkedEntries.find(l=>l.id===e.id));

  const addLink=(targetEntry)=>{
    const gid=linkGroup||`lg-${Date.now()}`;
    // 対象エントリに linkGroup を付ける
    onSaveBaseKeepOpen({...targetEntry,linkGroup:gid});
    // 自分自身にも linkGroup のみ付ける（他フィールドは変更しない）
    if(baseEntry) onSaveBaseKeepOpen({...baseEntry,linkGroup:gid});
    setLinkGroup(gid);
  };
  const removeLink=(targetEntry)=>{
    onSaveBaseKeepOpen({...targetEntry,linkGroup:undefined});
    if(linkedEntries.length<=1){
      // 最後のリンクが外れる → 自分のlinkGroupのみ解除（他フィールドは変更しない）
      if(baseEntry) onSaveBaseKeepOpen({...baseEntry,linkGroup:undefined});
      setLinkGroup(null);
    }
  };

  const tn=id=>teachers.find(t=>t.id===id)?.name||"";
  const matchedT=isSubst?teachers:teachers.filter(t=>selCids.some(cid=>(t.asgn||[]).some(a=>a.c===cid&&a.s===selSubj)));
  const teacherList=matchedT.length>0?matchedT:teachers;

  // 学級・教科が変わったとき担当先生を自動選択（補欠モードでない場合）
  React.useEffect(()=>{
    if(isSubst)return;
    if(matchedT.length===0)return;
    // 現在選択中の先生が全員担当外 → 担当先生に切り替え
    const allOutsider=selTids.length>0&&selTids.every(tid=>!matchedT.find(t=>t.id===tid));
    // 担当先生が1人だけ → 自動選択（技術→理科のような教科切り替え時）
    const singleMatch=matchedT.length===1;
    if(allOutsider||singleMatch){
      setSelTids(matchedT.map(t=>t.id));
    }
  },[selSubj,selCids.join(','),isSubst]);
  const matchedS=isSubst?subjects:[...new Set(selTids.flatMap(tid=>{const t=teachers.find(x=>x.id===tid);return t?(t.asgn||[]).filter(a=>selCids.some(cid=>a.c===cid)).map(a=>a.s):[];}))];
  const subjList=[...new Set([...matchedS,...(isSubst?subjects:[])])];
  if(subjList.length===0)subjList.push(...(subjects||[]));
  const sortedSubjList=(subjects||[]).map(s=>({s,matched:subjList.includes(s)}))
    .concat(subjList.filter(s=>!(subjects||[]).includes(s)).map(s=>({s,matched:true})));

  const toggleTid=id=>setSelTids(p=>p.includes(id)?p.filter(x=>x!==id):[...p,id]);
  const toggleCid=id=>setSelCids(p=>p.includes(id)?p.filter(x=>x!==id):[...p,id]);

  const canSave=tab==="change"?isBlocked?selCids.length>0:selCids.length>0&&selTids.length>0:selCids.length>0&&selTids.length>0;

  const save=()=>{
    if(!canSave)return;
    if(tab==="change"&&date){
      if(isBlocked) onSaveChange({date,period,classIds:selCids,teacherIds:[],subject:"",isSubst:false,isBlocked:true,note:blockReason});
      else          onSaveChange({date,period,classIds:selCids,teacherIds:selTids,subject:selSubj,isSubst,isBlocked:false,note});
    }else{
      if(addingPair){
        // B週ペア追加モード → 新規エントリとして保存
        onAddBase({day,period,classIds:selCids,teacherIds:selTids,subject:selSubj,note,altWeek:altWeek||undefined});
      }else if(baseEntry){
        onSaveBase({...baseEntry,classIds:selCids,teacherIds:selTids,subject:selSubj,note,linkGroup:linkGroup||undefined,altWeek:altWeek||undefined});
      }else{
        onAddBase({day,period,classIds:selCids,teacherIds:selTids,subject:selSubj,note,linkGroup:linkGroup||undefined,altWeek:altWeek||undefined});
      }
    }
  };

  const INP2={width:"100%",padding:"6px 10px",border:"1.5px solid #E5E7EB",borderRadius:5,fontSize:12,color:"#1E293B",boxSizing:"border-box"};

  return(
    <div style={{position:"fixed",inset:0,background:"rgba(15,23,42,0.6)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:300}} onClick={onClose}>
      <div style={{background:"white",borderRadius:12,width:400,maxWidth:"96vw",boxShadow:"0 20px 60px rgba(0,0,0,0.3)",maxHeight:"94vh",display:"flex",flexDirection:"column"}} onClick={e=>e.stopPropagation()}>
        <div style={{padding:"16px 20px 12px",borderBottom:"1px solid #F1F5F9",flexShrink:0}}>
          <div style={{fontSize:11,color:"#94A3B8"}}>{day}曜日 第{period}限{date?` ／ ${date.slice(5).replace("-","月")}日`:""}</div>
          <div style={{fontWeight:700,fontSize:16,color:"#1E3A5F",marginTop:2}}>授業の設定</div>
        </div>
        {isChangeMode&&(
          <div style={{display:"flex",gap:4,padding:"10px 20px 0",flexShrink:0}}>
            {[{v:"change",l:"📝 日課変更"},{v:"base",l:"✏️ 基本を修正"}].map(({v,l})=>(
              <button key={v} onClick={()=>setTab(v)} style={{flex:1,padding:"8px",border:"none",borderRadius:"6px 6px 0 0",cursor:"pointer",fontSize:12,fontWeight:tab===v?700:400,background:tab===v?"#1E3A5F":"#F1F5F9",color:tab===v?"white":"#64748B"}}>
                {l}
              </button>
            ))}
          </div>
        )}
        <div style={{overflowY:"auto",flex:1,padding:"14px 20px",minHeight:0}}>
          {isChangeMode&&baseEntry&&(
            <div style={{background:"#F8FAFC",border:"1px solid #E2E8F0",borderRadius:6,padding:"8px 10px",marginBottom:14,fontSize:12}}>
              <div style={{fontSize:10,color:"#94A3B8",fontWeight:600,marginBottom:3}}>基本時間割（参照）</div>
              <span style={{background:SC[baseEntry.subject]||"#EEE",padding:"2px 10px",borderRadius:3,fontSize:13,fontWeight:700}}>{baseEntry.subject}</span>
              <span style={{color:"#64748B",marginLeft:8}}>{(baseEntry.teacherIds||[]).map(t=>tn(t)+"先生").join("・")}</span>
            </div>
          )}
          {tab==="change"&&(
            <div>
              {/* 学校単位の時限入れ替え（日課パターン）を開くボタン */}
              {onOpenPeriodPattern&&date&&(
                <button onClick={e=>onOpenPeriodPattern(e)}
                  style={{width:"100%",marginBottom:14,padding:"10px 14px",textAlign:"left",
                    background:"#F5F3FF",border:"2px solid #C4B5FD",borderRadius:8,cursor:"pointer"}}>
                  <div style={{fontWeight:700,fontSize:13,color:"#6D28D9"}}>⇄ この時限に別の曜日・時限の授業を入れる（学校全体）</div>
                  <div style={{fontSize:11,color:"#94A3B8",marginTop:2}}>例：月曜6限に火曜3限の授業を全学級いっせいに実施。日課パターンとして保存され、移動候補にも反映されます。</div>
                </button>
              )}
              <div style={{marginBottom:14,borderRadius:8,border:`2px solid ${isBlocked?"#4B5563":"#E5E7EB"}`,overflow:"hidden"}}>
                <label style={{display:"flex",alignItems:"center",gap:10,padding:"12px 14px",background:isBlocked?"#374151":"#FAFAFA",cursor:"pointer"}}>
                  <input type="checkbox" checked={isBlocked} onChange={e=>setIsBlocked(e.target.checked)} style={{width:18,height:18,accentColor:"#374151",flexShrink:0}}/>
                  <div>
                    <div style={{fontWeight:700,fontSize:14,color:isBlocked?"white":"#1F2937"}}>🚫 この時限を空きにする</div>
                    <div style={{fontSize:11,color:isBlocked?"#D1D5DB":"#9CA3AF",marginTop:1}}>出張・研修・会議・振替などで授業に入れない場合</div>
                  </div>
                </label>
                {isBlocked&&(
                  <div style={{padding:"12px 14px",background:"white",borderTop:"1px solid #E5E7EB"}}>
                    <div style={{fontSize:11,color:"#374151",fontWeight:700,marginBottom:8}}>理由を選択</div>
                    <div style={{display:"flex",gap:8,marginBottom:10}}>
                      {["欠課","出張","その他"].map(r=>(
                        <button key={r} onClick={()=>{
                          if(r==="欠課") setBlockReason("欠課");
                          else if(r==="出張") setBlockReason("出張");
                          else setBlockReason(blockReason.startsWith("その他：")?blockReason:"その他：");
                        }} style={{flex:1,padding:"8px 6px",borderRadius:6,fontSize:13,cursor:"pointer",border:"1.5px solid",fontWeight:(r==="欠課"?blockReason==="欠課":r==="出張"?blockReason==="出張":blockReason.startsWith("その他："))?700:400,borderColor:(r==="欠課"?blockReason==="欠課":r==="出張"?blockReason==="出張":blockReason.startsWith("その他："))?"#374151":"#D1D5DB",background:(r==="欠課"?blockReason==="欠課":r==="出張"?blockReason==="出張":blockReason.startsWith("その他："))?"#374151":"white",color:(r==="欠課"?blockReason==="欠課":r==="出張"?blockReason==="出張":blockReason.startsWith("その他："))?"white":"#374151"}}>
                          {r==="欠課"?"📋 "+r:r==="出張"?"🚙 "+r:"📝 "+r}
                        </button>
                      ))}
                    </div>
                    {(blockReason.startsWith("その他：")||blockReason==="その他：")&&(
                      <input value={blockReason.replace("その他：","")} onChange={e=>setBlockReason("その他："+e.target.value)}
                        placeholder="理由を入力" style={INP2} autoFocus/>
                    )}
                  </div>
                )}
              </div>
              {!isBlocked&&(
                <div>
                  <label style={{display:"flex",alignItems:"center",gap:8,marginBottom:12,cursor:"pointer",padding:"8px 10px",background:isSubst?"#FFF1F2":"#F8FAFC",borderRadius:7,border:`1.5px solid ${isSubst?"#FECACA":"#E2E8F0"}`}}>
                    <input type="checkbox" checked={isSubst} onChange={e=>setIsSubst(e.target.checked)} style={{width:15,height:15,accentColor:"#EF4444"}}/>
                    <div>
                      <div style={{fontWeight:isSubst?700:400,color:isSubst?"#DC2626":"#334155",fontSize:12}}>補欠授業として登録（担当外の教員・教科も選択可）</div>
                    </div>
                  </label>
                  <Sec label="学級" sub="（複数→合同授業）">
                    <div style={{display:"flex",flexWrap:"wrap"}}>{classes.map(c=><Pill key={c.id} on={selCids.includes(c.id)} onClick={()=>toggleCid(c.id)}>{c.name}</Pill>)}</div>
                  </Sec>
                  <Sec label="教科">
                    <div style={{display:"flex",flexWrap:"wrap"}}>{sortedSubjList.map(({s,matched})=><Pill key={s} on={selSubj===s} onClick={()=>setSelSubj(s)}><span style={{display:"inline-block",width:8,height:8,borderRadius:2,background:gc(s),border:"1px solid rgba(0,0,0,0.1)",marginRight:3,verticalAlign:"middle"}}/>{s}</Pill>)}</div>
                  </Sec>
                  <Sec label="担当教員" sub="（複数→TT）">
                    <div style={{display:"flex",flexWrap:"wrap"}}>
                      {teachers.map(t=>{const m=!!matchedT.find(x=>x.id===t.id);return <Pill key={t.id} on={selTids.includes(t.id)} onClick={()=>toggleTid(t.id)} extra={!m?"担当外":null}>{t.name}先生</Pill>;})}
                    </div>
                  </Sec>
                  <Sec label="変更理由・備考">
                    <input value={note} onChange={e=>setNote(e.target.value)} placeholder="例：学校行事のため" style={INP2}/>
                  </Sec>
                </div>
              )}
            </div>
          )}
          {tab==="base"&&(
            <div>
              <Sec label="学級" sub="（複数→合同授業）">
                <div style={{display:"flex",flexWrap:"wrap"}}>{classes.map(c=><Pill key={c.id} on={selCids.includes(c.id)} onClick={()=>toggleCid(c.id)}>{c.name}</Pill>)}</div>
              </Sec>
              <Sec label="教科">
                <div style={{display:"flex",flexWrap:"wrap"}}>{sortedSubjList.map(({s,matched})=><Pill key={s} on={selSubj===s} onClick={()=>setSelSubj(s)}><span style={{display:"inline-block",width:8,height:8,borderRadius:2,background:gc(s),border:"1px solid rgba(0,0,0,0.1)",marginRight:3,verticalAlign:"middle"}}/>{s}</Pill>)}</div>
              </Sec>
              <Sec label="担当教員" sub="（複数→TT）">
                <div style={{display:"flex",flexWrap:"wrap"}}>{teachers.map(t=>{const m=!!matchedT.find(x=>x.id===t.id);return <Pill key={t.id} on={selTids.includes(t.id)} onClick={()=>toggleTid(t.id)} extra={!m?"担当外":null}>{t.name}先生</Pill>;})}</div>
              </Sec>
              <Sec label="備考・メモ">
                <input value={note} onChange={e=>setNote(e.target.value)} placeholder="例：A君通級、TT補助など" style={INP2}/>
              </Sec>
              <Sec label="🗓 隔週設定" sub="未設定なら毎週表示">
                <div style={{display:"flex",gap:6,alignItems:"center"}}>
                  {[{v:"A",l:"A週のみ"},{v:"B",l:"B週のみ"}].map(({v,l})=>(
                    <button key={v} onClick={()=>setAltWeek(altWeek===v?"":v)}
                      style={{padding:"5px 14px",borderRadius:5,border:"1.5px solid",cursor:"pointer",fontSize:12,fontWeight:altWeek===v?700:400,
                        borderColor:altWeek===v?(v==="A"?"#2563EB":"#D97706"):"#CBD5E1",
                        background:altWeek===v?(v==="A"?"#EFF6FF":"#FEF3C7"):"white",
                        color:altWeek===v?(v==="A"?"#2563EB":"#D97706"):"#64748B"}}>
                      {l}
                    </button>
                  ))}
                  {altWeek&&<button onClick={()=>setAltWeek("")}
                    style={{fontSize:11,padding:"3px 8px",border:"1px solid #E2E8F0",borderRadius:4,cursor:"pointer",background:"#F8FAFC",color:"#94A3B8"}}>
                    解除（毎週に戻す）
                  </button>}
                </div>
                {altWeek&&<div style={{fontSize:10,color:"#94A3B8",marginTop:4}}>週間日課変更ビューで{altWeek}週のみ表示されます</div>}
                {altWeek&&baseEntry&&baseEntry.altWeek!==altWeek&&(
                  <div style={{marginTop:6,padding:"6px 10px",background:"#FEF9C3",borderRadius:5,border:"1px solid #FCD34D",fontSize:11,color:"#92400E"}}>
                    ⚠ 「基本を保存」すると既存の駒を上書きします。隔週ペアとして追加するには別途「＋」ボタンから新規登録してください。
                  </div>
                )}
              </Sec>
              {/* 🔗 連動リンク */}
              <Sec label="🔗 連動リンク" sub="移動時に一緒に動かす">
                {linkedEntries.length>0&&(
                  <div style={{marginBottom:8}}>
                    {linkedEntries.map(e=>(
                      <div key={e.id} style={{display:"flex",alignItems:"center",justifyContent:"space-between",
                        padding:"5px 10px",marginBottom:4,background:"#EFF6FF",borderRadius:6,border:"1px solid #BFDBFE"}}>
                        <span style={{fontSize:12,color:"#1E40AF",fontWeight:600}}>
                          🔗 {e.subject}・{(e.classIds||[]).map(c=>cn(c)).join("・")}
                          {(e.teacherIds||[]).length>0&&<span style={{color:"#64748B",fontWeight:400}}>・{(e.teacherIds||[]).map(t=>tn(t)).join("・")}先生</span>}
                        </span>
                        <button onClick={()=>removeLink(e)}
                          style={{background:"none",border:"none",cursor:"pointer",color:"#94A3B8",fontSize:14,padding:"0 4px",lineHeight:1}}>✕</button>
                      </div>
                    ))}
                  </div>
                )}
                {linkCandidates.length>0?(
                  <div>
                    <div style={{fontSize:11,color:"#64748B",marginBottom:4}}>リンクする授業を選択：</div>
                    <div style={{display:"flex",flexWrap:"wrap",gap:4}}>
                      {linkCandidates.map(e=>(
                        <button key={e.id} onClick={()=>addLink(e)}
                          style={{padding:"3px 10px",border:"1.5px solid #CBD5E1",borderRadius:5,cursor:"pointer",
                            fontSize:11,background:"white",color:"#374151"}}>
                          ＋ {e.subject}・{(e.classIds||[]).map(c=>cn(c)).join("・")}
                        </button>
                      ))}
                    </div>
                  </div>
                ):(
                  <div style={{fontSize:11,color:"#94A3B8"}}>同じ時限に他の授業がありません</div>
                )}
                {linkGroup&&(
                  <button onClick={()=>{
                    // 自分自身（baseEntry）のlinkGroupのみ解除（他フィールドは変更しない）
                    if(baseEntry)onSaveBaseKeepOpen({...baseEntry,linkGroup:undefined});
                    linkedEntries.forEach(e=>onSaveBaseKeepOpen({...e,linkGroup:undefined}));
                    setLinkGroup(null);
                  }} style={{marginTop:8,padding:"4px 10px",background:"#FEF2F2",color:"#DC2626",
                    border:"1px solid #FECACA",borderRadius:5,cursor:"pointer",fontSize:11,fontWeight:700}}>
                    🔗 全リンクを解除
                  </button>
                )}
              </Sec>
            </div>
          )}
        </div>
        <div style={{padding:"12px 20px",borderTop:"1px solid #F1F5F9",display:"flex",gap:6,flexShrink:0}}>
          <button onClick={save} disabled={!canSave} style={{flex:1,padding:"10px",background:!canSave?"#E2E8F0":tab==="change"?(isBlocked?"#374151":"#F59E0B"):"#1E3A5F",color:!canSave?"#94A3B8":"white",border:"none",borderRadius:6,cursor:canSave?"pointer":"not-allowed",fontSize:14,fontWeight:700}}>
            {tab==="change"?(isBlocked?"🚫 空きで保存":"💾 変更を保存"):"💾 基本を保存"}
          </button>
          {existChg&&<button onClick={()=>onClearChange(existChg.id)} style={{padding:"10px 12px",background:"#FEE2E2",color:"#DC2626",border:"1px solid #FECACA",borderRadius:6,cursor:"pointer",fontSize:12,fontWeight:600}}>取消</button>}
          {tab==="base"&&baseEntry&&baseEntry.altWeek&&(
            <button onClick={()=>{
              // 反対週の空エントリを事前作成してからモーダルを閉じる
              // ユーザーはセルを再度開いて反対週エントリを編集できる
              const pairWeek=baseEntry.altWeek==="A"?"B":"A";
              // B週追加モードに切り替え（フォームをリセットしてペア追加UI表示）
              setAddingPair(true);
              setAltWeek(pairWeek);
              setSelSubj(baseEntry.subject||"");
              setSelCids([...baseEntry.classIds]);
              setSelTids([...(baseEntry.teacherIds||[])]);
              setNote("");
            }}
            style={{padding:"10px 12px",background:"#EFF6FF",color:"#2563EB",border:"1px solid #BFDBFE",borderRadius:6,cursor:"pointer",fontSize:12,fontWeight:700,whiteSpace:"nowrap"}}>
              ＋ {baseEntry.altWeek==="A"?"B":"A"}週を追加して編集
            </button>
          )}
          {tab==="base"&&baseEntry&&!addingPair&&<button onClick={()=>onDelBase(baseEntry.id)} style={{padding:"10px 12px",background:"#FEE2E2",color:"#DC2626",border:"1px solid #FECACA",borderRadius:6,cursor:"pointer",fontSize:12}}>削除</button>}
          {addingPair&&<button onClick={()=>setAddingPair(false)} style={{padding:"10px 12px",background:"#F1F5F9",color:"#64748B",border:"none",borderRadius:6,cursor:"pointer",fontSize:12}}>← 戻る</button>}
          <button onClick={onClose} style={{padding:"10px 12px",background:"#F1F5F9",color:"#64748B",border:"none",borderRadius:6,cursor:"pointer",fontSize:14,fontWeight:700}}>✕</button>
        </div>
      </div>
    </div>
  );
}

// ── AssignGrid ────────────────────────────────────────────────────────────────
function AssignGrid({teacher,classes,subjects,setTeachers}){
  const getN=(c,s)=>(teacher.asgn||[]).find(a=>a.c===c&&a.s===s)?.n||0;
  const setN=(c,s,v)=>{
    const n=Math.max(0,Math.min(10,Number(v)||0));
    setTeachers(p=>p.map(t=>{
      if(t.id!==teacher.id)return t;
      const newAsgn=(t.asgn||[]).filter(a=>!(a.c===c&&a.s===s));
      if(n>0)newAsgn.push({c,s,n});
      return{...t,asgn:newAsgn};
    }));
  };
  const totalN=(teacher.asgn||[]).reduce((a,x)=>a+(x.n||0),0);
  const resetAll=()=>setTeachers(p=>p.map(t=>t.id!==teacher.id?t:{...t,asgn:[]}));
  return(
    <div>
      <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:10}}>
        <span style={{fontSize:13,fontWeight:700,color:"#1E3A5F"}}>{teacher.name}先生の担当</span>
        <span style={{background:"#EEF2FF",color:"#4338CA",borderRadius:4,padding:"2px 8px",fontSize:11,fontWeight:700}}>合計 {totalN} コマ / 週</span>
        <button onClick={resetAll}
          style={{marginLeft:"auto",fontSize:11,padding:"2px 10px",border:"1px solid #FECACA",borderRadius:4,cursor:"pointer",background:"#FEF2F2",color:"#DC2626",fontWeight:700}}>
          🔄 全てゼロにリセット
        </button>
      </div>
      <div style={{overflowX:"auto",overflowY:"auto",maxHeight:"60vh",position:"relative"}}>
        <table style={{borderCollapse:"collapse",fontSize:12}}>
          <thead>
            <tr>
              <th style={{padding:"5px 8px",background:"#F1F5F9",border:"1px solid #E2E8F0",minWidth:64,textAlign:"left",position:"sticky",top:0,left:0,zIndex:4,boxShadow:"2px 2px 0 #E2E8F0"}}>教科＼学級</th>
              {classes.map(c=><th key={c.id} style={{padding:"5px 8px",background:"#F1F5F9",border:"1px solid #E2E8F0",minWidth:58,textAlign:"center",whiteSpace:"nowrap",fontSize:11,position:"sticky",top:0,zIndex:3}}>{c.name}</th>)}
            </tr>
          </thead>
          <tbody>
            {subjects.map(s=>(
              <tr key={s}>
                <td style={{padding:"4px 8px",background:gc(s)||"#F8FAFC",border:"1px solid #E2E8F0",fontWeight:700,position:"sticky",left:0,zIndex:2,boxShadow:"2px 0 4px rgba(0,0,0,0.06)"}}>{s}</td>
                {classes.map(c=>{
                  const n=getN(c.id,s);
                  return(
                    <td key={c.id} style={{padding:"3px",border:"1px solid #E2E8F0",background:n>0?gc(s)+"99":"#FAFAFA",textAlign:"center"}}>
                      <div style={{display:"flex",alignItems:"center",justifyContent:"center",gap:1}}>
                        <button onClick={()=>setN(c.id,s,n-1)} style={{width:18,height:18,border:"1px solid #CBD5E1",borderRadius:3,cursor:"pointer",background:"white",fontSize:13,padding:0,fontWeight:700,lineHeight:"16px"}}>−</button>
                        <span style={{minWidth:20,textAlign:"center",fontWeight:n>0?700:400,fontSize:14,color:n>0?"#1E293B":"#D1D5DB"}}>{n||"·"}</span>
                        <button onClick={()=>setN(c.id,s,n+1)} style={{width:18,height:18,border:"1px solid #CBD5E1",borderRadius:3,cursor:"pointer",background:"white",fontSize:13,padding:0,fontWeight:700,lineHeight:"16px"}}>＋</button>
                      </div>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Setup Modal ───────────────────────────────────────────────────────────────
function SetupModal({schoolName,setSchoolName,adminEmails,setAdminEmails,classes,setClasses,subjects,setSubjects,weeklyPlan,setWeeklyPlan,schoolSlots,setSchoolSlots,teachers,setTeachers,changes,onApplyHoliday,onRemoveBlocked,abWeekBase,setAbWeekBase,onClose,isDemo=false}){
  const[tab,setTab]=useState("school");
  const[newCls,setNewCls]=useState("");
  const[editCls,setEditCls]=useState(null);
  const[editClsName,setEditClsName]=useState("");
  const[newSubj,setNewSubj]=useState("");
  const[newTch,setNewTch]=useState("");
  const[editTch,setEditTch]=useState(null);
  const[editTchName,setEditTchName]=useState("");
  const[selCls,setSelCls]=useState(classes[0]?.id||"");
  const[newEmail,setNewEmail]=useState("");
  // 管理者（adminsテーブル直結）: ログイン編集権限を持つ人の一覧
  const[adminList,setAdminList]=useState(null); // null=読み込み中
  const[adminBusy,setAdminBusy]=useState(false);
  const[adminErr,setAdminErr]=useState("");
  const reloadAdmins=async()=>{
    try{const rows=await sbListAdmins();setAdminList(Array.isArray(rows)?rows.map(r=>r.email):[]);}
    catch(e){setAdminErr("一覧の取得に失敗しました");setAdminList([]);}
  };
  useEffect(()=>{reloadAdmins();},[]);
  const normEmail=(s)=>String(s||"").trim().toLowerCase();
  const handleAddAdmin=async()=>{
    const email=normEmail(newEmail);setAdminErr("");
    if(!email)return;
    if(!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)){setAdminErr("メールアドレスの形式が正しくありません");return;}
    if((adminList||[]).map(normEmail).includes(email)){setAdminErr("すでに登録されています");return;}
    setAdminBusy(true);
    try{
      const res=await sbAddAdmin(email);
      if(!res.ok&&res.status!==201){setAdminErr("追加できませんでした（権限をご確認ください）");}
      else{setNewEmail("");await reloadAdmins();}
    }catch(e){setAdminErr("追加に失敗しました");}
    setAdminBusy(false);
  };
  const handleRemoveAdmin=async(email)=>{
    setAdminErr("");
    if((adminList||[]).length<=1){setAdminErr("管理者が1人のときは削除できません");return;}
    if(!window.confirm(email+" を管理者から削除しますか？\nこの人はログインして編集できなくなります。"))return;
    setAdminBusy(true);
    try{
      const res=await sbRemoveAdmin(email);
      if(!res.ok&&res.status!==204){setAdminErr("削除できませんでした");}
      else{await reloadAdmins();}
    }catch(e){setAdminErr("削除に失敗しました");}
    setAdminBusy(false);
  };
  const INP={padding:"6px 10px",border:"1.5px solid #E2E8F0",borderRadius:5,fontSize:13,color:"#1E293B",flex:1,boxSizing:"border-box",width:"100%"};
  const BTN=(bg,co,extra={})=>({padding:"5px 12px",background:bg,color:co,border:"none",borderRadius:5,cursor:"pointer",fontSize:12,fontWeight:700,whiteSpace:"nowrap",...extra});
  const sc=s=>({"国語":"#FDE8E8","数学":"#DBEAFE","英語":"#D1FAE5","理科":"#DCFCE7","社会":"#FEF9C3","音楽":"#EDE9FE","美術":"#FEE2CC","体育":"#BAE6FD","技術":"#CCFBF1","家庭":"#FCE7F3","道徳":"#E0F2FE","学活":"#F3E8FF","総合":"#FEF3C7","生活":"#ECFDF5","自立":"#E0F7FA","図工":"#FFFBEB"})[s]||"#F3F4F6";
  const addCls=()=>{if(!newCls.trim())return;setClasses(p=>[...p,{id:`c${Date.now()}`,name:newCls.trim()}]);setNewCls("");};
  const delCls=id=>setClasses(p=>p.filter(c=>c.id!==id));
  const saveCls=(id,name)=>{setClasses(p=>p.map(c=>c.id===id?{...c,name}:c));setEditCls(null);};
  const addSubj=()=>{if(!newSubj.trim()||subjects.includes(newSubj.trim()))return;setSubjects(p=>[...p,newSubj.trim()]);setNewSubj("");};
  const delSubj=s=>setSubjects(p=>p.filter(x=>x!==s));
  const addTch=()=>{if(!newTch.trim())return;const id="T"+(Date.now()%100000).toString().padStart(4,"0");setTeachers(p=>[...p,{id,name:newTch.trim(),asgn:[]}]);setNewTch("");};
  const delTch=id=>setTeachers(p=>p.filter(t=>t.id!==id));
  const TABS=[{k:"school",l:"🏫 学校情報"},{k:"class",l:"📋 学級設定"},{k:"subject",l:"📚 教科設定"},{k:"teacher",l:"➕ 教員追加/削除"},{k:"assign",l:"👤 担当・コマ数"},{k:"holiday",l:"🗓 祝日登録"}];
  const[modalSize,setModalSize]=React.useState({w:660,h:Math.min(600,window.innerHeight*0.9)});
  const isResizingRef=React.useRef(false);
  const startResize=(e,dir)=>{
    e.preventDefault();
    e.stopPropagation();
    isResizingRef.current=true;
    document.body.style.userSelect='none';
    const startX=e.clientX,startY=e.clientY;
    const startW=modalSize.w,startH=modalSize.h;
    const onMove=mv=>{
      mv.preventDefault();
      mv.stopPropagation();
      const dx=mv.clientX-startX,dy=mv.clientY-startY;
      setModalSize({
        w:Math.max(400,Math.min(window.innerWidth*0.98,startW+(dir.includes('e')?dx:dir.includes('w')?-dx:0))),
        h:Math.max(300,Math.min(window.innerHeight*0.97,startH+(dir.includes('s')?dy:dir.includes('n')?-dy:0))),
      });
    };
    const onUp=()=>{
      isResizingRef.current=false;
      document.body.style.userSelect='';
      window.removeEventListener('mousemove',onMove);
      window.removeEventListener('mouseup',onUp);
    };
    window.addEventListener('mousemove',onMove);
    window.addEventListener('mouseup',onUp);
  };
  const HANDLE_BASE={position:'absolute',zIndex:10,userSelect:'none'};
  const corners=[
    {dir:'nw',style:{top:-4,left:-4,width:12,height:12,cursor:'nw-resize'}},
    {dir:'ne',style:{top:-4,right:-4,width:12,height:12,cursor:'ne-resize'}},
    {dir:'sw',style:{bottom:-4,left:-4,width:12,height:12,cursor:'sw-resize'}},
    {dir:'se',style:{bottom:-4,right:-4,width:12,height:12,cursor:'se-resize'}},
    {dir:'n',style:{top:-4,left:'20%',right:'20%',height:8,cursor:'n-resize'}},
    {dir:'s',style:{bottom:-4,left:'20%',right:'20%',height:8,cursor:'s-resize'}},
    {dir:'w',style:{left:-4,top:'20%',bottom:'20%',width:8,cursor:'w-resize'}},
    {dir:'e',style:{right:-4,top:'20%',bottom:'20%',width:8,cursor:'e-resize'}},
  ];
  return(
    <div style={{position:"fixed",inset:0,background:"rgba(15,23,42,0.65)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:400}} onClick={onClose} onDragOver={e=>e.preventDefault()} onDrop={e=>e.preventDefault()}>
      <div data-setup-modal="1" style={{background:"white",borderRadius:12,width:modalSize.w,height:modalSize.h,display:"flex",flexDirection:"column",boxShadow:"0 20px 60px rgba(0,0,0,0.3)",position:"relative"}} onClick={e=>e.stopPropagation()}>
        {corners.map(({dir,style})=>(
          <div key={dir} onMouseDown={e=>startResize(e,dir)}
            style={{...HANDLE_BASE,...style,background:'transparent'}}/>
        ))}
        <div style={{padding:"14px 20px 0",borderBottom:"1px solid #F1F5F9",flexShrink:0}}>
          <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:10}}>
            <div style={{fontWeight:700,fontSize:16,color:"#1E3A5F"}}>⚙ 初期設定</div>
            <button onClick={onClose} style={{background:"none",border:"none",fontSize:18,cursor:"pointer",color:"#94A3B8",lineHeight:1,padding:"0 2px"}}>×</button>
          </div>
          <div style={{display:"flex",gap:3,flexWrap:"wrap"}}>
            {TABS.map(({k,l})=>(
              <button key={k} onClick={()=>setTab(k)} style={{padding:"6px 14px",border:"none",borderRadius:"6px 6px 0 0",cursor:"pointer",fontSize:12,fontWeight:tab===k?700:400,background:tab===k?"#1E3A5F":"#F1F5F9",color:tab===k?"white":"#64748B"}}>{l}</button>
            ))}
          </div>
        </div>
        <div style={{overflowY:"auto",flex:1,padding:"16px 20px"}}>
          {tab==="school"&&(
            <div>
              <div style={{fontSize:12,color:"#64748B",marginBottom:14}}>学校名を設定します。ヘッダーに表示されます。</div>
              {/* A/B週基準週設定 */}
              <div style={{marginBottom:16,padding:"12px 14px",background:"#EFF6FF",borderRadius:8,border:"1px solid #BFDBFE"}}>
                <label style={{display:"block",fontSize:12,fontWeight:700,color:"#1E40AF",marginBottom:6}}>🗓 隔週A/B週の基準週</label>
                <div style={{fontSize:11,color:"#64748B",marginBottom:8}}>この週の月曜日を「A週」として交互に切り替わります</div>
                <div style={{display:"flex",gap:8,alignItems:"center",flexWrap:"wrap"}}>
                  <input type="date" value={abWeekBase||""} onChange={e=>setAbWeekBase(getMon(e.target.value)||e.target.value)}
                    style={{padding:"5px 10px",border:"1.5px solid #BFDBFE",borderRadius:5,fontSize:12,color:"#1E293B"}}/>
                  {abWeekBase&&<span style={{fontSize:11,color:"#1E40AF",fontWeight:700}}>基準週: {abWeekBase}（月）</span>}
                  {abWeekBase&&<button onClick={()=>setAbWeekBase("")}
                    style={{fontSize:11,padding:"3px 8px",border:"1px solid #FECACA",borderRadius:4,cursor:"pointer",background:"#FEF2F2",color:"#DC2626"}}>解除</button>}
                </div>
              </div>
              <label style={{display:"block",fontSize:12,fontWeight:700,color:"#475569",marginBottom:6}}>学校名</label>
              <input value={schoolName} onChange={e=>setSchoolName(e.target.value)} placeholder="例：〇〇中学校" style={{...INP,marginBottom:16}}/>

              {/* 学校で使用する曜日×時限の設定 */}
              <div style={{marginBottom:16,padding:"12px 14px",background:"#F8FAFC",borderRadius:8,border:"1px solid #E2E8F0"}}>
                <label style={{display:"block",fontSize:12,fontWeight:700,color:"#475569",marginBottom:4}}>🕐 学校で使用する曜日・時限</label>
                <div style={{fontSize:11,color:"#64748B",marginBottom:8,lineHeight:1.6}}>
                  チェックを外した時限は、基本時間割・週間日課変更の<b>移動候補（玉突き含む）に表示されません</b>。手動ドラッグでの配置は可能です。<br/>
                  <b>未設定</b>の場合：基本時間割では「全校で授業が1コマもない枠」を自動的に除外し、週間日課変更では制限しません。
                </div>
                <table style={{borderCollapse:"collapse",fontSize:12}}>
                  <thead>
                    <tr>
                      <th style={{padding:"3px 8px",color:"#94A3B8",fontWeight:600}}></th>
                      {DAYS.map(d=><th key={d} style={{padding:"3px 8px",color:"#475569",fontWeight:700}}>{d}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {PERIODS.map(p=>(
                      <tr key={p}>
                        <td style={{padding:"3px 8px",color:"#475569",fontWeight:700,textAlign:"right"}}>{p}限</td>
                        {DAYS.map(d=>{
                          const on=schoolSlots?(schoolSlots[d]||[]).includes(p):true;
                          return(
                            <td key={d} style={{padding:"3px 8px",textAlign:"center"}}>
                              <input type="checkbox" checked={on} style={{cursor:"pointer",width:15,height:15,accentColor:"#1E3A5F"}}
                                onChange={()=>{
                                  setSchoolSlots(prev=>{
                                    const cur=prev||Object.fromEntries(DAYS.map(dd=>[dd,[...PERIODS]]));
                                    const set=new Set(cur[d]||[]);
                                    set.has(p)?set.delete(p):set.add(p);
                                    return{...cur,[d]:[...set].sort((a,b)=>a-b)};
                                  });
                                }}/>
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div style={{display:"flex",gap:8,marginTop:8,alignItems:"center"}}>
                  {schoolSlots?(
                    <>
                      <span style={{fontSize:11,color:"#15803D",fontWeight:700}}>✓ 設定済み（候補はこの表に従います）</span>
                      <button onClick={()=>{if(window.confirm("使用時限の設定を解除して未設定に戻しますか？"))setSchoolSlots(null);}}
                        style={{fontSize:11,padding:"3px 10px",border:"1px solid #FECACA",borderRadius:4,cursor:"pointer",background:"#FEF2F2",color:"#DC2626"}}>未設定に戻す</button>
                    </>
                  ):(
                    <span style={{fontSize:11,color:"#94A3B8"}}>未設定（どこかのチェックを変更すると設定が有効になります）</span>
                  )}
                </div>
              </div>

              {!isDemo&&(<>
              <label style={{display:"block",fontSize:12,fontWeight:700,color:"#475569",marginBottom:6}}>管理者メールアドレス</label>
              <div style={{fontSize:11,color:"#64748B",marginBottom:8,lineHeight:1.6}}>登録したメールアドレスの人が、Googleでログインすると<b>時間割を編集できる管理者</b>になります。</div>
              <div style={{display:"flex",flexDirection:"column",gap:4,marginBottom:8}}>
                {adminList===null&&<div style={{fontSize:12,color:"#94A3B8",padding:"6px 4px"}}>読み込み中…</div>}
                {adminList!==null&&adminList.length===0&&<div style={{fontSize:12,color:"#94A3B8",padding:"6px 4px"}}>登録されていません</div>}
                {(adminList||[]).map((email,i)=>{
                  const onlyOne=(adminList||[]).length<=1;
                  return(
                    <div key={i} style={{display:"flex",alignItems:"center",gap:6,padding:"5px 10px",background:"#F8FAFC",borderRadius:6,border:"1px solid #E2E8F0"}}>
                      <span style={{flex:1,fontSize:12,color:"#1E293B"}}>📧 {email}</span>
                      <button onClick={()=>handleRemoveAdmin(email)} disabled={adminBusy||onlyOne} title={onlyOne?"管理者が1人のときは削除できません":""}
                        style={{background:onlyOne?"#F1F5F9":"#FEE2E2",color:onlyOne?"#94A3B8":"#DC2626",border:"none",borderRadius:4,padding:"2px 8px",fontSize:11,cursor:(adminBusy||onlyOne)?"default":"pointer",fontWeight:700}}>解除</button>
                    </div>
                  );
                })}
              </div>
              {adminErr&&<div style={{color:"#DC2626",fontSize:12,marginBottom:8}}>{adminErr}</div>}
              <div style={{display:"flex",gap:6}}>
                <input value={newEmail} onChange={e=>setNewEmail(e.target.value)}
                  onKeyDown={e=>{if(e.key==="Enter")handleAddAdmin();}}
                  placeholder="例：teacher@tonami-city.ed.jp" style={{...INP,marginBottom:0}}/>
                <button onClick={handleAddAdmin} disabled={adminBusy}
                  style={BTN("#1E3A5F","white",{opacity:adminBusy?0.6:1})}>＋ 登録</button>
              </div>
              </>)}

              <div style={{background:"#F0F9FF",borderRadius:8,padding:"12px 14px",border:"1px solid #BAE6FD",fontSize:12,color:"#0369A1",marginTop:16}}>
                💡 設定の順序：①学校情報 → ②学級設定 → ③教科設定 → ④教員追加/削除 → ⑤担当・コマ数
              </div>
            </div>
          )}
          {tab==="class"&&(
            <div>
              <div style={{fontSize:12,color:"#64748B",marginBottom:12}}>学級名を追加・削除・変更できます。並び替えは ▲▼ で。</div>
              <div style={{display:"flex",flexDirection:"column",gap:4,marginBottom:12}}>
                {classes.map((c,i)=>(
                  <div key={c.id} style={{display:"flex",alignItems:"center",gap:6,padding:"7px 10px",background:i%2===0?"#F8FAFC":"white",borderRadius:6,border:"1px solid #F1F5F9"}}>
                    {editCls===c.id
                      ?<><input autoFocus value={editClsName} onChange={e=>setEditClsName(e.target.value)} onKeyDown={e=>e.key==="Enter"&&saveCls(c.id,editClsName)} style={{...INP,flex:1}}/>
                        <button onClick={()=>saveCls(c.id,editClsName)} style={BTN("#1E3A5F","white")}>保存</button>
                        <button onClick={()=>setEditCls(null)} style={BTN("#F1F5F9","#64748B")}>取消</button></>
                      :<><span style={{flex:1,fontSize:13,fontWeight:600}}>{c.name}</span>
                        <button onClick={()=>{if(i===0)return;const a=[...classes];[a[i-1],a[i]]=[a[i],a[i-1]];setClasses(a);}} disabled={i===0}
                          style={{background:"rgba(0,0,0,0.08)",border:"none",borderRadius:3,cursor:i===0?"default":"pointer",color:"#374151",fontSize:12,padding:"0 6px",lineHeight:"22px",opacity:i===0?0.3:1}}>▲</button>
                        <button onClick={()=>{if(i===classes.length-1)return;const a=[...classes];[a[i],a[i+1]]=[a[i+1],a[i]];setClasses(a);}} disabled={i===classes.length-1}
                          style={{background:"rgba(0,0,0,0.08)",border:"none",borderRadius:3,cursor:i===classes.length-1?"default":"pointer",color:"#374151",fontSize:12,padding:"0 6px",lineHeight:"22px",opacity:i===classes.length-1?0.3:1}}>▼</button>
                        <button onClick={()=>{setEditCls(c.id);setEditClsName(c.name);}} style={BTN("#F1F5F9","#334155")}>✏️</button>
                        <button onClick={()=>delCls(c.id)} style={BTN("#FEE2E2","#DC2626")}>削除</button></>}
                  </div>
                ))}
              </div>
              <div style={{display:"flex",gap:8,padding:"10px 12px",background:"#F8FAFC",borderRadius:7,border:"1px solid #E2E8F0"}}>
                <input value={newCls} onChange={e=>setNewCls(e.target.value)} onKeyDown={e=>e.key==="Enter"&&addCls()} placeholder="例：3年1組" style={{...INP}}/>
                <button onClick={addCls} style={BTN("#1E3A5F","white")}>＋ 追加</button>
              </div>
            </div>
          )}
          {tab==="subject"&&(
            <div>
              <div style={{fontSize:12,color:"#64748B",marginBottom:12}}>教科を追加・削除・並び替えができます。</div>
              <div style={{display:"flex",flexDirection:"column",gap:4,marginBottom:14}}>
                {subjects.map((s,i)=>(
                  <div key={s} style={{display:"flex",alignItems:"center",gap:6,background:sc(s),border:"1px solid rgba(0,0,0,0.08)",borderRadius:6,padding:"4px 8px",fontSize:13}}>
                    <span style={{fontWeight:600,color:"#1E293B",flex:1}}>{s}</span>
                    <button onClick={()=>{if(i===0)return;const a=[...subjects];[a[i-1],a[i]]=[a[i],a[i-1]];setSubjects(a);}} disabled={i===0}
                      style={{background:"rgba(0,0,0,0.08)",border:"none",borderRadius:3,cursor:i===0?"default":"pointer",color:"#374151",fontSize:12,padding:"0 6px",lineHeight:"18px",opacity:i===0?0.3:1}}>▲</button>
                    <button onClick={()=>{if(i===subjects.length-1)return;const a=[...subjects];[a[i],a[i+1]]=[a[i+1],a[i]];setSubjects(a);}} disabled={i===subjects.length-1}
                      style={{background:"rgba(0,0,0,0.08)",border:"none",borderRadius:3,cursor:i===subjects.length-1?"default":"pointer",color:"#374151",fontSize:12,padding:"0 6px",lineHeight:"18px",opacity:i===subjects.length-1?0.3:1}}>▼</button>
                    <button onClick={e=>{e.stopPropagation();delSubj(s);}}
                      style={{background:"rgba(220,38,38,0.12)",border:"none",borderRadius:3,cursor:"pointer",color:"#DC2626",fontSize:11,padding:"0 6px",lineHeight:"18px"}}>×</button>
                  </div>
                ))}
              </div>
              <div style={{display:"flex",gap:8,padding:"10px 12px",background:"#F8FAFC",borderRadius:7,border:"1px solid #E2E8F0"}}>
                <input value={newSubj} onChange={e=>setNewSubj(e.target.value)} onKeyDown={e=>e.key==="Enter"&&addSubj()} placeholder="例：情報" style={{...INP}}/>
                <button onClick={addSubj} style={BTN("#1E3A5F","white")}>＋ 追加</button>
              </div>
            </div>
          )}
          {tab==="assign"&&(
            <div>
              <div style={{fontSize:12,color:"#64748B",marginBottom:10}}>教員ごとに担当学級・教科・週コマ数を設定します。</div>
              <div style={{display:"flex",gap:4,marginBottom:14,flexWrap:"wrap"}}>
                {teachers.map(t=>(
                  <button key={t.id} onClick={()=>setSelCls(t.id)}
                    style={{padding:"4px 12px",border:"1.5px solid",borderRadius:16,cursor:"pointer",fontSize:12,
                      borderColor:selCls===t.id?"#1E3A5F":"#CBD5E1",background:selCls===t.id?"#1E3A5F":"white",
                      color:selCls===t.id?"white":"#334155",fontWeight:selCls===t.id?700:400}}>
                    {t.name}先生
                  </button>
                ))}
              </div>
              {teachers.find(t=>t.id===selCls)&&
                <AssignGrid teacher={teachers.find(t=>t.id===selCls)} classes={classes} subjects={subjects} setTeachers={setTeachers}/>
              }
            </div>
          )}
          {tab==="holiday"&&(
            <HolidayImportModal
              classes={classes}
              changes={changes}
              onApply={onApplyHoliday}
              onRemoveBlocked={onRemoveBlocked}
              onClose={()=>setTab("school")}
              inline={true}
            />
          )}
          {tab==="teacher"&&(
            <div>
              <div style={{fontSize:12,color:"#64748B",marginBottom:12}}>教員の追加・削除・名前変更・在籍期間を設定できます。</div>
              <div style={{display:"flex",flexDirection:"column",gap:3,marginBottom:12}}>
                {teachers.map((t,i)=>(
                  <div key={t.id} style={{background:i%2===0?"#F8FAFC":"white",borderRadius:6,border:"1px solid #F1F5F9",overflow:"hidden"}}>
                    <div style={{display:"flex",alignItems:"center",gap:6,padding:"7px 10px"}}>
                      {editTch===t.id
                        ?<><input autoFocus value={editTchName} onChange={e=>setEditTchName(e.target.value)} onKeyDown={e=>{if(e.key==="Enter"){setTeachers(p=>p.map(x=>x.id===t.id?{...x,name:editTchName}:x));setEditTch(null);}}} style={{...INP,flex:1}}/>
                          <button onClick={()=>{setTeachers(p=>p.map(x=>x.id===t.id?{...x,name:editTchName}:x));setEditTch(null);}} style={BTN("#1E3A5F","white")}>保存</button>
                          <button onClick={()=>setEditTch(null)} style={BTN("#F1F5F9","#64748B")}>取消</button></>
                        :<><span style={{flex:1,fontSize:13,fontWeight:600}}>{t.name}先生</span>
                          <span style={{background:"#EEF2FF",color:"#4338CA",borderRadius:4,padding:"2px 7px",fontSize:11,fontWeight:700}}>{t.asgn?.length||0}コマ</span>
                          {(t.startDate||t.endDate)&&<span style={{background:"#FEF3C7",color:"#92400E",borderRadius:4,padding:"2px 6px",fontSize:10}}>
                            {t.startDate||''}〜{t.endDate||''}
                          </span>}
                          <button onClick={()=>{setEditTch(t.id);setEditTchName(t.name);}} style={BTN("#F1F5F9","#334155")}>✏️</button>
                          <button onClick={()=>delTch(t.id)} style={BTN("#FEE2E2","#DC2626")}>削除</button></>}
                    </div>
                    {/* ⑥ 在籍期間 */}
                    <div style={{display:"flex",alignItems:"center",gap:6,padding:"4px 10px 6px",background:"rgba(0,0,0,0.02)",borderTop:"1px solid #F1F5F9"}}>
                      <span style={{fontSize:10,color:"#94A3B8",whiteSpace:"nowrap"}}>在籍期間：</span>
                      <input type="date" value={t.startDate||""} onChange={e=>setTeachers(p=>p.map(x=>x.id===t.id?{...x,startDate:e.target.value||undefined}:x))}
                        style={{fontSize:11,border:"1px solid #E2E8F0",borderRadius:4,padding:"2px 6px",color:"#334155",background:"white"}}/>
                      <span style={{fontSize:11,color:"#94A3B8"}}>〜</span>
                      <input type="date" value={t.endDate||""} onChange={e=>setTeachers(p=>p.map(x=>x.id===t.id?{...x,endDate:e.target.value||undefined}:x))}
                        style={{fontSize:11,border:"1px solid #E2E8F0",borderRadius:4,padding:"2px 6px",color:"#334155",background:"white"}}/>
                      <span style={{fontSize:10,color:"#94A3B8"}}>（空欄＝無制限）</span>
                      {(t.startDate||t.endDate)&&<button onClick={()=>setTeachers(p=>p.map(x=>x.id===t.id?{...x,startDate:undefined,endDate:undefined}:x))}
                        style={{fontSize:10,padding:"1px 6px",border:"1px solid #FECACA",borderRadius:3,cursor:"pointer",background:"#FEF2F2",color:"#DC2626"}}>解除</button>}
                    </div>
                    {/* 出勤スロット設定（曜日×時限グリッド） */}
                    {(()=>{
                      const slots=t.unavailableSlots||[];
                      // availableDays の旧データを unavailableSlots に変換して表示
                      const legacyAbsent=(t.availableDays
                        ?DAYS7.filter(d=>!t.availableDays.includes(d)):[]);
                      const isUnavail=(day,period)=>{
                        if(legacyAbsent.includes(day))return true;
                        return slots.includes(`${day}-${period}`);
                      };
                      const toggleSlot=(day,period)=>{
                        const key=`${day}-${period}`;
                        // まず availableDays があれば unavailableSlots に統合
                        let base=[];
                        if(t.availableDays){
                          DAYS7.filter(d=>!t.availableDays.includes(d)).forEach(d=>{
                            PERIODS.forEach(p=>base.push(`${d}-${p}`));
                          });
                        }
                        base=[...new Set([...(t.unavailableSlots||[]),...base])];
                        const next=base.includes(key)?base.filter(k=>k!==key):[...base,key];
                        setTeachers(p=>p.map(x=>x.id===t.id?{...x,unavailableSlots:next,availableDays:undefined}:x));
                      };
                      const toggleDay=(day)=>{
                        const allAbsent=PERIODS.every(p=>isUnavail(day,p));
                        let base=[];
                        if(t.availableDays){
                          DAYS7.filter(d=>!t.availableDays.includes(d)).forEach(d=>{
                            PERIODS.forEach(p=>base.push(`${d}-${p}`));
                          });
                        }
                        base=[...new Set([...(t.unavailableSlots||[]),...base])];
                        let next;
                        if(allAbsent){
                          next=base.filter(k=>!k.startsWith(`${day}-`));
                        }else{
                          next=[...base,...PERIODS.filter(p=>!isUnavail(day,p)).map(p=>`${day}-${p}`)];
                        }
                        setTeachers(p=>p.map(x=>x.id===t.id?{...x,unavailableSlots:[...new Set(next)],availableDays:undefined}:x));
                      };
                      const hasAny=DAYS7.some(d=>PERIODS.some(p=>isUnavail(d,p)));
                      const resetAll=()=>setTeachers(p=>p.map(x=>x.id===t.id?{...x,unavailableSlots:[],availableDays:undefined}:x));
                      return(
                        <div style={{padding:"6px 10px 8px",background:"rgba(0,0,0,0.02)"}}>
                          <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:5}}>
                            <span style={{fontSize:10,color:"#94A3B8",whiteSpace:"nowrap"}}>不在スロット：</span>
                            {hasAny
                              ?<span style={{fontSize:9,background:"#FEF3C7",color:"#92400E",borderRadius:3,padding:"1px 5px",fontWeight:700}}>非常勤設定あり</span>
                              :<span style={{fontSize:10,color:"#CBD5E1"}}>なし（全日出勤）</span>}
                            {hasAny&&<button onClick={resetAll}
                              style={{fontSize:9,padding:"1px 6px",border:"1px solid #E2E8F0",borderRadius:3,cursor:"pointer",background:"white",color:"#64748B",marginLeft:"auto"}}>
                              全解除
                            </button>}
                          </div>
                          <div style={{display:"inline-grid",gridTemplateColumns:`auto repeat(7,22px)`,gap:2,fontSize:10}}>
                            <div/>
                            {DAYS7.map(d=>{
                              const allAbsent=PERIODS.every(p=>isUnavail(d,p));
                              const someAbsent=PERIODS.some(p=>isUnavail(d,p));
                              return(
                                <div key={d} onClick={()=>toggleDay(d)}
                                  style={{textAlign:"center",fontWeight:700,cursor:"pointer",fontSize:9,
                                    color:allAbsent?"#DC2626":someAbsent?"#F59E0B":"#64748B",
                                    borderBottom:`2px solid ${allAbsent?"#FCA5A5":someAbsent?"#FDE68A":"#E2E8F0"}`,
                                    paddingBottom:1}}>
                                  {d}
                                </div>
                              );
                            })}
                            {PERIODS.map(p=>(
                              <React.Fragment key={p}>
                                <div style={{fontSize:9,color:"#94A3B8",textAlign:"right",paddingRight:3,lineHeight:"22px"}}>{p}限</div>
                                {DAYS7.map(d=>{
                                  const absent=isUnavail(d,p);
                                  return(
                                    <div key={d} onClick={()=>toggleSlot(d,p)}
                                      title={`${d}曜${p}限 ${absent?"（不在）クリックで出勤に":"（出勤）クリックで不在に"}`}
                                      style={{width:22,height:22,borderRadius:3,cursor:"pointer",
                                        border:`1px solid ${absent?"#FCA5A5":"#E2E8F0"}`,
                                        background:absent?"#FEE2E2":"white",
                                        display:"flex",alignItems:"center",justifyContent:"center",
                                        fontSize:10,color:absent?"#DC2626":"#D1D5DB",
                                        transition:"all 0.1s"}}>
                                      {absent?"✕":""}
                                    </div>
                                  );
                                })}
                              </React.Fragment>
                            ))}
                          </div>
                          <div style={{fontSize:9,color:"#CBD5E1",marginTop:4}}>
                            曜日名クリックで全時限一括 ／ セルクリックで時限単位
                          </div>
                        </div>
                      );
                    })()}
                  </div>
                ))}
              </div>
              <div style={{display:"flex",gap:8,padding:"10px 12px",background:"#F8FAFC",borderRadius:7,border:"1px solid #E2E8F0"}}>
                <input value={newTch} onChange={e=>setNewTch(e.target.value)} onKeyDown={e=>e.key==="Enter"&&addTch()} placeholder="名前を入力（例：佐々木）" style={{...INP}}/>
                <button onClick={addTch} style={BTN("#1E3A5F","white")}>＋ 追加</button>
              </div>
              <div style={{fontSize:11,color:"#94A3B8",marginTop:8}}>追加後は「担当・コマ数」タブで担当学級・教科を設定してください。</div>
            </div>
          )}
        </div>
        <div style={{padding:"12px 20px",borderTop:"1px solid #F1F5F9",display:"flex",justifyContent:"flex-end",flexShrink:0}}>
          <button onClick={onClose} style={{padding:"8px 22px",background:"#1E3A5F",color:"white",border:"none",borderRadius:6,cursor:"pointer",fontSize:13,fontWeight:700}}>閉じる</button>
        </div>
      </div>
    </div>
  );
}

// ── ⑤ BackupRestoreModal ─────────────────────────────────────────────────────
function BackupRestoreModal({onRestore,onClose}){
  const[list,setList]=useState(null);
  const[loading,setLoading]=useState(true);
  const[deleting,setDeleting]=useState(null);
  const[error,setError]=useState(null);

  useEffect(()=>{
    sbListBackups()
      .then(rows=>{
        if(Array.isArray(rows)){
          setList(rows);
        }else{
          setError(rows?.message||JSON.stringify(rows));
          setList([]);
        }
      })
      .catch(e=>{setError(String(e));setList([]);})
      .finally(()=>setLoading(false));
  },[]);

  const fmtDt=iso=>{
    const d=new Date(iso);
    return`${d.getFullYear()}/${String(d.getMonth()+1).padStart(2,'0')}/${String(d.getDate()).padStart(2,'0')} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
  };

  const isPinned=row=>row.label?.startsWith('📌');

  const handlePin=async(row,e)=>{
    e.stopPropagation();
    const pinned=isPinned(row);
    const newLabel=pinned
      ?(row.label||'').replace(/^📌\s*/,'')
      :'📌 '+(row.label||'(ラベルなし)');
    await sbFetch(`/rest/v1/timetable_backups?id=eq.${row.id}`,{
      method:'PATCH',
      headers:{'Prefer':'return=minimal'},
      body:JSON.stringify({label:newLabel}),
    });
    setList(p=>p.map(r=>r.id===row.id?{...r,label:newLabel}:r));
  };

  const handleDelete=async(row,e)=>{
    e.stopPropagation();
    if(isPinned(row)){alert('📌 固定されたバックアップは削除できません。\nまずピンを外してください。');return;}
    if(!window.confirm('このバックアップを削除しますか？'))return;
    setDeleting(row.id);
    await sbDeleteBackup(row.id);
    setList(p=>p.filter(r=>r.id!==row.id));
    setDeleting(null);
  };

  const sortedList=[...(list||[])].sort((a,b)=>{
    const pa=isPinned(a)?0:1,pb=isPinned(b)?0:1;
    if(pa!==pb)return pa-pb;
    return new Date(b.created_at)-new Date(a.created_at);
  });

  return(
    <div style={{position:'fixed',inset:0,background:'rgba(15,23,42,0.65)',display:'flex',alignItems:'center',justifyContent:'center',zIndex:500}} onClick={onClose}>
      <div style={{background:'white',borderRadius:12,width:520,maxWidth:'96vw',maxHeight:'82vh',display:'flex',flexDirection:'column',boxShadow:'0 20px 60px rgba(0,0,0,0.3)'}} onClick={e=>e.stopPropagation()}>
        <div style={{padding:'16px 20px 12px',borderBottom:'1px solid #F1F5F9'}}>
          <div style={{fontWeight:700,fontSize:16,color:'#1E3A5F'}}>📦 バックアップから復元</div>
          <div style={{fontSize:11,color:'#94A3B8',marginTop:3}}>📌 で固定すると自動消去されません。行クリックで復元、🗑 で削除。</div>
        </div>
        <div style={{overflowY:'auto',flex:1,padding:'12px 20px'}}>
          {loading&&<div style={{textAlign:'center',color:'#94A3B8',padding:32,fontSize:13}}>読み込み中...</div>}
          {!loading&&error&&(
            <div style={{margin:16,padding:'12px 14px',background:'#FEF2F2',border:'1px solid #FECACA',borderRadius:8,fontSize:12,color:'#DC2626'}}>
              <div style={{fontWeight:700,marginBottom:4}}>⚠ 読み込みエラー</div>
              <div style={{fontFamily:'monospace',fontSize:11,wordBreak:'break-all'}}>{error}</div>
              <div style={{marginTop:8,fontSize:11,color:'#6B7280'}}>SupabaseのSQLで <code>timetable_backups</code> テーブルが作成済か確認してください。</div>
            </div>
          )}
          {!loading&&!error&&sortedList.length===0&&(
            <div style={{textAlign:'center',color:'#94A3B8',padding:32,fontSize:13}}>バックアップがありません</div>
          )}
          {!loading&&sortedList.map((row,i)=>{
            const pinned=isPinned(row);
            return(
              <div key={row.id}
                onMouseEnter={e=>e.currentTarget.style.background='#EFF6FF'}
                onMouseLeave={e=>e.currentTarget.style.background=pinned?'#FFFBEB':i%2===0?'#F8FAFC':'white'}
                onClick={()=>{
                  if(!window.confirm(`「${row.label||'(ラベルなし)'}」（${fmtDt(row.created_at)}）を復元しますか？\n現在のデータは上書きされます。`))return;
                  onRestore(row.id);
                }}
                style={{display:'flex',alignItems:'center',gap:8,padding:'10px 12px',
                  background:pinned?'#FFFBEB':i%2===0?'#F8FAFC':'white',
                  borderRadius:7,border:pinned?'1.5px solid #FCD34D':'1px solid #E2E8F0',
                  marginBottom:5,cursor:'pointer',transition:'background 0.1s'}}>
                <button onClick={e=>handlePin(row,e)} title={pinned?'ピンを外す':'固定する（自動消去しない）'}
                  style={{background:'none',border:'none',cursor:'pointer',fontSize:16,padding:'2px 4px',opacity:pinned?1:0.25,flexShrink:0,transition:'opacity 0.15s'}}
                  onMouseEnter={e=>e.currentTarget.style.opacity='1'}
                  onMouseLeave={e=>e.currentTarget.style.opacity=pinned?'1':'0.25'}>
                  📌
                </button>
                <div style={{flex:1,minWidth:0}}>
                  <div style={{fontWeight:700,fontSize:13,color:'#1E293B',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>
                    {(row.label||'(ラベルなし)').replace(/^📌\s*/,'')}
                  </div>
                  <div style={{fontSize:11,color:'#64748B',marginTop:2}}>{fmtDt(row.created_at)}</div>
                </div>
                <div style={{fontSize:11,color:'#94A3B8',whiteSpace:'nowrap',flexShrink:0}}>{row.data?.base?.length??'?'}コマ</div>
                <div style={{fontSize:11,color:'#94A3B8',whiteSpace:'nowrap',flexShrink:0}}>変更{row.data?.changes?.length??'?'}件</div>
                <button disabled={deleting===row.id||pinned} onClick={e=>handleDelete(row,e)}
                  title={pinned?'固定中は削除できません':'削除'}
                  style={{background:pinned?'#F1F5F9':'#FEE2E2',border:'none',borderRadius:5,
                    cursor:pinned?'not-allowed':'pointer',padding:'4px 8px',fontSize:13,
                    color:pinned?'#CBD5E1':'#DC2626',fontWeight:700,flexShrink:0,opacity:deleting===row.id?0.5:1}}>
                  {deleting===row.id?'…':'🗑'}
                </button>
              </div>
            );
          })}
        </div>
        <div style={{padding:'12px 20px',borderTop:'1px solid #F1F5F9',display:'flex',justifyContent:'space-between',alignItems:'center'}}>
          <div style={{fontSize:11,color:'#94A3B8'}}>📌 固定バックアップは自動消去・削除不可 ／ 復元後は自動保存されます</div>
          <button onClick={onClose} style={{padding:'8px 22px',background:'#1E3A5F',color:'white',border:'none',borderRadius:6,cursor:'pointer',fontSize:13,fontWeight:700}}>閉じる</button>
        </div>
      </div>
    </div>
  );
}


// ── BackupDropdown ─────────────────────────────────────────────────────────────
// ── ヘッダー用 ホバー展開メニュー ──────────────────────────────────────────────
// label: トップメニュー名 / items: [{label, onClick, badge?}]（falsyな要素は無視）
// マウスを乗せると下にサブメニューが開く。クリック／タップでも開閉できる。
function HeaderMenu({label,items}){
  const [open,setOpen]=React.useState(false);
  const [pos,setPos]=React.useState({left:0,top:0});
  const wrapRef=React.useRef(null);
  const btnRef=React.useRef(null);
  const closeTimer=React.useRef(null);
  const place=()=>{const r=btnRef.current&&btnRef.current.getBoundingClientRect();if(r)setPos({left:r.left,top:r.bottom+4});};
  const openMenu=()=>{if(closeTimer.current){clearTimeout(closeTimer.current);closeTimer.current=null;}place();setOpen(true);};
  const scheduleClose=()=>{if(closeTimer.current)clearTimeout(closeTimer.current);closeTimer.current=setTimeout(()=>setOpen(false),140);};
  React.useEffect(()=>{
    if(!open)return;
    const onDown=e=>{if(wrapRef.current&&!wrapRef.current.contains(e.target))setOpen(false);};
    document.addEventListener("mousedown",onDown);
    return ()=>document.removeEventListener("mousedown",onDown);
  },[open]);
  const list=(items||[]).filter(Boolean);
  const trigStyle={background:open?"rgba(255,255,255,0.25)":"rgba(255,255,255,0.12)",border:"1px solid rgba(255,255,255,0.25)",color:"white",padding:"3px 12px",borderRadius:4,cursor:"pointer",fontSize:11,fontWeight:700,whiteSpace:"nowrap",flexShrink:0,display:"inline-flex",alignItems:"center"};
  return (
    <div ref={wrapRef} style={{position:"relative",flexShrink:0}} onMouseEnter={openMenu} onMouseLeave={scheduleClose}>
      <button ref={btnRef} onClick={()=>open?setOpen(false):openMenu()} style={trigStyle}>
        {label}<span style={{marginLeft:5,fontSize:9,opacity:0.85}}>▾</span>
      </button>
      {open&&(
        <div onMouseEnter={openMenu} onMouseLeave={scheduleClose}
          style={{position:"fixed",left:pos.left,top:pos.top,background:"#FFFFFF",color:"#1E293B",
            border:"1px solid #CBD5E1",borderRadius:8,boxShadow:"0 10px 28px rgba(0,0,0,0.20)",
            padding:6,minWidth:200,zIndex:10000,display:"flex",flexDirection:"column",gap:2}}>
          {list.map((it,i)=>(
            <button key={i} onClick={()=>{setOpen(false);it.onClick&&it.onClick();}}
              onMouseEnter={e=>{e.currentTarget.style.background="#F1F5F9";}}
              onMouseLeave={e=>{e.currentTarget.style.background="transparent";}}
              style={{display:"flex",alignItems:"center",gap:8,width:"100%",textAlign:"left",
                background:"transparent",border:"none",cursor:"pointer",fontSize:12,fontWeight:600,
                padding:"9px 12px",borderRadius:6,color:"#1E293B",whiteSpace:"nowrap"}}>
              <span>{it.label}</span>
              {it.badge!=null&&<span style={{marginLeft:"auto",background:"#1E3A5F",color:"#fff",borderRadius:9,padding:"1px 7px",fontSize:10,fontWeight:700}}>{it.badge}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ── 汎用ホバーメニュー（ヘッダー用ドロップダウン） ───────────────────────────
// マウスを乗せると下にサブメニューが開く。クリックでも開閉できる。
// メニュー本体は position:fixed（ヘッダーの横スクロール領域でも隠れない）。
function HoverMenu({icon,label,items,badge=0}){
  const[open,setOpen]=useState(false);
  const[pos,setPos]=useState({top:0,left:0});
  const wrapRef=useRef(null);
  const timer=useRef(null);
  const compute=()=>{
    if(wrapRef.current){
      const r=wrapRef.current.getBoundingClientRect();
      const menuW=250;
      let left=r.left;
      if(left+menuW>window.innerWidth-8)left=window.innerWidth-menuW-8;
      setPos({top:r.bottom+2,left:Math.max(8,left)});
    }
  };
  const openNow=()=>{clearTimeout(timer.current);compute();setOpen(true);};
  const closeSoon=()=>{clearTimeout(timer.current);timer.current=setTimeout(()=>setOpen(false),180);};
  useEffect(()=>()=>clearTimeout(timer.current),[]);
  const itemBase={
    display:'flex',alignItems:'center',gap:10,width:'100%',textAlign:'left',
    padding:'10px 14px',border:'none',cursor:'pointer',fontSize:13,background:'white',
    color:'#1E293B',transition:'background 0.1s',
  };
  return(
    <div ref={wrapRef} onMouseEnter={openNow} onMouseLeave={closeSoon} style={{position:'relative',flexShrink:0}}>
      <button onClick={()=>{open?setOpen(false):openNow();}}
        style={{
          background:open?'rgba(255,255,255,0.25)':'rgba(255,255,255,0.12)',
          border:'1px solid rgba(255,255,255,0.3)',color:'white',
          padding:'3px 11px',borderRadius:4,cursor:'pointer',
          fontSize:11,fontWeight:700,whiteSpace:'nowrap',
          display:'flex',alignItems:'center',gap:5,
        }}>
        {icon} {label}
        {badge>0&&<span style={{marginLeft:1,background:'rgba(255,255,255,0.25)',borderRadius:8,padding:'0 5px',fontSize:10}}>{badge}</span>}
        <span style={{fontSize:9,opacity:0.8}}>{open?'▲':'▼'}</span>
      </button>
      {open&&(
        <div onMouseEnter={openNow} onMouseLeave={closeSoon}
          style={{
            position:'fixed',top:pos.top,left:pos.left,background:'white',borderRadius:10,
            boxShadow:'0 8px 32px rgba(0,0,0,0.22)',border:'1px solid #E2E8F0',
            minWidth:230,zIndex:99999,overflow:'hidden',
          }}>
          {items.map((it,i)=>(
            <button key={i}
              onMouseEnter={e=>e.currentTarget.style.background=it.hover||'#F0F9FF'}
              onMouseLeave={e=>e.currentTarget.style.background='white'}
              onClick={()=>{setOpen(false);it.onClick();}}
              style={{...itemBase,borderBottom:i===items.length-1?'none':'1px solid #F1F5F9'}}>
              <span style={{fontSize:20}}>{it.icon}</span>
              <div>
                <div style={{fontWeight:700,color:it.color||'#1E293B'}}>
                  {it.label}
                  {it.badge>0&&<span style={{marginLeft:6,background:'#EDE9FE',color:'#6D28D9',borderRadius:8,padding:'0 6px',fontSize:11}}>{it.badge}</span>}
                </div>
                {it.desc&&<div style={{fontSize:11,color:'#94A3B8',marginTop:1}}>{it.desc}</div>}
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function BackupDropdown({saveRef,saving,setSaving,setBackupModal,base,setBase,changes,setChanges,teachers,setTeachers,classes,setBench,openIntegrity}){
  const[open,setOpen]=useState(false);
  const[pos,setPos]=useState({top:0,right:0});
  const btnRef=useRef(null);

  useEffect(()=>{
    if(!open)return;
    const handler=e=>{
      if(btnRef.current&&!btnRef.current.contains(e.target))setOpen(false);
    };
    document.addEventListener('mousedown',handler);
    return()=>document.removeEventListener('mousedown',handler);
  },[open]);

  const handleOpen=()=>{
    if(btnRef.current){
      const r=btnRef.current.getBoundingClientRect();
      setPos({top:r.bottom+4, right:window.innerWidth-r.right});
    }
    setOpen(o=>!o);
  };

  const btnBase={
    display:'flex',alignItems:'center',gap:10,width:'100%',textAlign:'left',
    padding:'10px 14px',border:'none',cursor:'pointer',fontSize:13,background:'white',
    borderBottom:'1px solid #F1F5F9',color:'#1E293B',transition:'background 0.1s',
  };

  return(
    <div ref={btnRef} style={{position:'relative',flexShrink:0}}>
      <button
        onClick={handleOpen}
        style={{
          background: open?'rgba(255,255,255,0.25)':'rgba(255,255,255,0.12)',
          border:'1px solid rgba(255,255,255,0.3)',
          color:'white',padding:'3px 11px',borderRadius:4,cursor:'pointer',
          fontSize:11,fontWeight:700,whiteSpace:'nowrap',
          display:'flex',alignItems:'center',gap:5,
        }}>
        📦 バックアップ関連
        <span style={{fontSize:9,opacity:0.8}}>{open?'▲':'▼'}</span>
      </button>

      {open&&(
        <div style={{
          position:'fixed',top:pos.top,right:pos.right,
          background:'white',borderRadius:10,
          boxShadow:'0 8px 32px rgba(0,0,0,0.22)',
          border:'1px solid #E2E8F0',minWidth:240,zIndex:99999,overflow:'hidden',
        }}>
          <div style={{padding:'10px 14px 8px',borderBottom:'1px solid #F1F5F9',
            fontSize:11,fontWeight:700,color:'#94A3B8',letterSpacing:'0.05em'}}>
            バックアップ関連
          </div>

          <button
            onMouseEnter={e=>e.currentTarget.style.background='#F0F9FF'}
            onMouseLeave={e=>e.currentTarget.style.background='white'}
            onClick={async()=>{
              setOpen(false);
              const label=window.prompt('バックアップのラベルを入力してください（省略可）');
              if(label===null)return;
              setSaving(true);
              try{
                await sbSaveBackup(saveRef.current,label||'手動バックアップ');
                alert('バックアップを保存しました。');
              }catch(e){
                alert('バックアップの保存に失敗しました。');
              }
              setSaving(false);
            }}
            style={{...btnBase}}>
            <span style={{fontSize:20}}>📦</span>
            <div>
              <div style={{fontWeight:700,color:'#0369A1'}}>バックアップを保存</div>
              <div style={{fontSize:11,color:'#94A3B8',marginTop:1}}>現在のデータをクラウドに保存</div>
            </div>
          </button>

          <button
            onMouseEnter={e=>e.currentTarget.style.background='#F0FDF4'}
            onMouseLeave={e=>e.currentTarget.style.background='white'}
            onClick={()=>{setOpen(false);setBackupModal(true);}}
            style={{...btnBase}}>
            <span style={{fontSize:20}}>↩</span>
            <div>
              <div style={{fontWeight:700,color:'#15803D'}}>バックアップから復元</div>
              <div style={{fontSize:11,color:'#94A3B8',marginTop:1}}>保存済みの世代を選んで戻す</div>
            </div>
          </button>

          <div style={{height:1,background:'#F1F5F9',margin:'4px 0'}}/>

          <button
            onMouseEnter={e=>e.currentTarget.style.background='#E0F2FE'}
            onMouseLeave={e=>e.currentTarget.style.background='white'}
            onClick={()=>{setOpen(false);openIntegrity();}}
            style={{...btnBase}}>
            <span style={{fontSize:20}}>🔍</span>
            <div>
              <div style={{fontWeight:700,color:'#0369A1'}}>データ整合性チェック</div>
              <div style={{fontSize:11,color:'#94A3B8',marginTop:1}}>先生・クラスリストとゴーストIDを表示・修復</div>
            </div>
          </button>

          <button
            onMouseEnter={e=>e.currentTarget.style.background='#FEF3C7'}
            onMouseLeave={e=>e.currentTarget.style.background='white'}
            onClick={async()=>{
              setOpen(false);
              const cnt=Array.isArray(changes)?changes.length:0;
              const ok=window.prompt(
                `⚠️ 変更データ ${cnt} 件を全てクリアします。\n`+
                "基本時間割と先生情報はそのまま残ります。\n"+
                "（実行前に自動でバックアップを保存します）\n\n"+
                "本当にクリアする場合は「クリア」と入力してください。"
              );
              if(ok!=="クリア")return;
              setSaving(true);
              try{await sbSaveBackup(saveRef.current,'変更クリア直前の自動バックアップ');}
              catch(e){console.error('backup before clear failed',e);}
              setSaving(false);
              setChanges([]);
            }}
            style={{...btnBase}}>
            <span style={{fontSize:20}}>🧹</span>
            <div>
              <div style={{fontWeight:700,color:'#B45309'}}>変更データのみクリア</div>
              <div style={{fontSize:11,color:'#94A3B8',marginTop:1}}>基本時間割は残す／自動バックアップ付</div>
            </div>
          </button>

          <button
            onMouseEnter={e=>e.currentTarget.style.background='#FFF1F2'}
            onMouseLeave={e=>e.currentTarget.style.background='white'}
            onClick={async()=>{
              setOpen(false);
              const ok=window.prompt(
                "⚠️ リセットすると全データが消えます。\n" +
                "（実行前に自動でバックアップを保存します）\n\n" +
                "本当にリセットする場合は「リセット」と入力してください。"
              );
              if(ok!=="リセット")return;
              setSaving(true);
              try{await sbSaveBackup(saveRef.current,'リセット直前の自動バックアップ');}
              catch(e){console.error('backup before reset failed',e);}
              setSaving(false);
              setBase(genBase());
              setChanges([]);
              setTeachers(INIT_T);
              setBench(Array(8).fill(null));
            }}
            style={{...btnBase,borderBottom:'none'}}>
            <span style={{fontSize:20}}>🔄</span>
            <div>
              <div style={{fontWeight:700,color:'#DC2626'}}>初期データにリセット</div>
              <div style={{fontSize:11,color:'#94A3B8',marginTop:1}}>実行前に自動バックアップを保存</div>
            </div>
          </button>
        </div>
      )}
    </div>
  );
}

// ── DayPatternBadge ────────────────────────────────────────────────────────────
function DayPatternBadge({date,dayPatterns,setDayPat}){
  const[open,setOpen]=useState(false);
  const[pos,setPos]=useState({top:0,left:0});
  const ref=useRef(null);
  const DAYS_B=["月","火","水","木","金"];
  const actualDow=(()=>{const w=new Date(date+"T00:00:00").getDay();return(w>=1&&w<=5)?DAYS_B[w-1]:null;})();
  const pat=dayPatterns.find(p=>p.date===date);
  const useDay=pat?.useDay||actualDow;
  const isCustom=!!pat?.useDay&&pat.useDay!==actualDow;

  useEffect(()=>{
    if(!open)return;
    const h=e=>{if(ref.current&&!ref.current.contains(e.target))setOpen(false);};
    document.addEventListener('mousedown',h);
    return()=>document.removeEventListener('mousedown',h);
  },[open]);

  const handleOpen=e=>{
    e.stopPropagation();
    if(ref.current){const r=ref.current.getBoundingClientRect();setPos({top:r.bottom+2,left:r.left});}
    setOpen(o=>!o);
  };

  return(
    <div ref={ref} style={{borderTop:"1px solid #E2E8F0"}}>
      <div onClick={handleOpen} style={{
        padding:"2px 6px",cursor:"pointer",fontSize:9,textAlign:"center",
        background:isCustom?"#FEF3C7":"transparent",
        color:isCustom?"#92400E":"#94A3B8",fontWeight:isCustom?700:400,
        whiteSpace:"nowrap",
      }}>
        {isCustom?`📅 ${useDay}曜日課`:`▾ 日課パターン`}
      </div>
      {open&&(
        <div style={{position:"fixed",top:pos.top,left:pos.left,zIndex:99999,
          background:"white",borderRadius:10,border:"1px solid #E2E8F0",
          boxShadow:"0 6px 24px rgba(0,0,0,0.15)",minWidth:150,overflow:"hidden"}}>
          <div style={{padding:"8px 12px 4px",fontSize:10,fontWeight:700,color:"#94A3B8"}}>この日の日課パターン</div>
          {DAYS_B.map(d=>{
            const isActual=d===actualDow;
            const isCur=d===useDay;
            return(
              <button key={d} onClick={()=>{setDayPat(date,isActual?null:d);setOpen(false);}}
                style={{display:"block",width:"100%",textAlign:"left",padding:"7px 14px",border:"none",
                  cursor:"pointer",background:isCur?"#EFF6FF":"white",
                  color:isCur?"#1D4ED8":"#1E293B",fontWeight:isCur?700:400,fontSize:12}}>
                {d}曜{isActual?"（通常）":"日課"}{isCur?" ✓":""}
              </button>
            );
          })}
          {isCustom&&<>
            <div style={{height:1,background:"#F1F5F9"}}/>
            <button onClick={()=>{setDayPat(date,null);setOpen(false);}}
              style={{display:"block",width:"100%",textAlign:"left",padding:"7px 14px",border:"none",
                cursor:"pointer",background:"white",color:"#EF4444",fontSize:12}}>✕ パターン解除</button>
          </>}
        </div>
      )}
    </div>
  );
}

// ── PeriodPatternPicker ────────────────────────────────────────────────────────
function PeriodPatternPicker({date,period,x,y,dayPatterns,setPeriodPat,clearPeriodPat,onClose}){
  const DAYS_P=["月","火","水","木","金"];
  const PERIODS_P=[1,2,3,4,5,6];
  const actualDow=(()=>{const w=new Date(date+"T00:00:00").getDay();return(w>=1&&w<=5)?DAYS_P[w-1]:null;})();
  const pat=dayPatterns.find(dp=>dp.date===date);
  const defDay=pat?.useDay||actualDow||"月";
  const pp=pat?.periods?.[String(period)];
  const[selDay,setSelDay]=useState(pp?.day||defDay);
  const[selPer,setSelPer]=useState(pp?.period??period);
  const isChanged=selDay!==defDay||selPer!==period;

  // 画面右端にはみ出さないよう調整
  const left=Math.min(x??0, window.innerWidth-240);
  const top=Math.min(y??0, window.innerHeight-320);

  return(
    <div onClick={e=>e.stopPropagation()} onPointerDown={e=>e.stopPropagation()}
      style={{position:"fixed",top,left,zIndex:99999,
        background:"white",border:"2px solid #6366F1",borderRadius:8,
        padding:"10px 12px",boxShadow:"0 8px 24px rgba(0,0,0,0.22)",minWidth:220,}}>
      <div style={{fontSize:11,fontWeight:700,color:"#6D28D9",marginBottom:4}}>
        ⇄ {period}限のコマに入れる内容
      </div>
      <div style={{fontSize:10,color:"#64748B",marginBottom:8,padding:"4px 8px",background:"#F5F3FF",borderRadius:4}}>
        「{period}限」のコマで実施する授業の時限を指定します
      </div>

      <div style={{marginBottom:6}}>
        <div style={{fontSize:10,color:"#94A3B8",marginBottom:3}}>曜日（通常は変更不要）</div>
        <div style={{display:"flex",gap:3,flexWrap:"wrap"}}>
          {DAYS_P.map(d=>(
            <button key={d} onClick={()=>setSelDay(d)}
              style={{padding:"3px 8px",border:"1.5px solid",borderRadius:4,cursor:"pointer",fontSize:12,
                borderColor:selDay===d?"#6366F1":"#E2E8F0",
                background:selDay===d?"#6366F1":"white",
                color:selDay===d?"white":"#334155",fontWeight:selDay===d?700:400}}>
              {d}{d===defDay?"（本日）":""}
            </button>
          ))}
        </div>
      </div>

      <div style={{marginBottom:10}}>
        <div style={{fontSize:10,color:"#94A3B8",marginBottom:3}}>何限の内容を使うか</div>
        <div style={{display:"flex",gap:3}}>
          {PERIODS_P.map(p=>(
            <button key={p} onClick={()=>setSelPer(p)}
              style={{padding:"4px 10px",border:"1.5px solid",borderRadius:4,cursor:"pointer",fontSize:13,
                borderColor:selPer===p?"#6366F1":"#E2E8F0",
                background:selPer===p?"#6366F1":"white",
                color:selPer===p?"white":"#334155",fontWeight:selPer===p?700:400}}>
              {p}限{p===period?"（元）":""}
            </button>
          ))}
        </div>
      </div>

      <div style={{fontSize:12,color:"#6D28D9",background:"#F5F3FF",borderRadius:5,padding:"6px 10px",marginBottom:8,textAlign:"center",fontWeight:700}}>
        {period}限のコマ → {selDay===defDay?"":`${selDay}曜`}{selPer}限の内容を実施
        {!isChanged&&<span style={{fontSize:10,fontWeight:400,color:"#94A3B8"}}> （変更なし）</span>}
      </div>

      <div style={{display:"flex",gap:4}}>
        <button onClick={()=>{if(isChanged)setPeriodPat(date,period,selDay,selPer);onClose();}}
          disabled={!isChanged}
          style={{flex:1,padding:"6px",background:isChanged?"#6366F1":"#E2E8F0",color:isChanged?"white":"#9CA3AF",border:"none",borderRadius:5,cursor:isChanged?"pointer":"default",fontSize:12,fontWeight:700}}>
          設定
        </button>
        {pp&&<button onClick={()=>{clearPeriodPat(date,period);onClose();}}
          style={{padding:"6px 10px",background:"#FEE2E2",color:"#DC2626",border:"none",borderRadius:5,cursor:"pointer",fontSize:11}}>
          解除
        </button>}
        <button onClick={onClose}
          style={{padding:"6px 10px",background:"#F1F5F9",color:"#64748B",border:"none",borderRadius:5,cursor:"pointer",fontSize:12}}>
          ✕
        </button>
      </div>
    </div>
  );
}


// ── HolidayImportModal ────────────────────────────────────────────────────────
function HolidayImportModal({classes,changes,onApply,onRemoveBlocked,onClose,inline=false}){
  const[inputTab,setInputTab]=React.useState("csv");
  const[csvText,setCsvText]=React.useState("");
  const[rangeStart,setRangeStart]=React.useState("");
  const[rangeEnd,setRangeEnd]=React.useState("");
  const[rangeName,setRangeName]=React.useState("夏季休業");
  const[rangeWeekdayOnly,setRangeWeekdayOnly]=React.useState(true);
  const[manualDate,setManualDate]=React.useState("");
  const[manualName,setManualName]=React.useState("振替休業日");
  const[entries,setEntries]=React.useState([]);
  const[selIds,setSelIds]=React.useState(new Set());
  const[selCids,setSelCids]=React.useState(new Set(classes.map(c=>c.id)));
  const[selPeriods,setSelPeriods]=React.useState(new Set([1,2,3,4,5,6]));
  // 削除タブ用
  const[delSelNotes,setDelSelNotes]=React.useState(new Set());

  const DOW_LABELS=["日","月","火","水","木","金","土"];
  const DOW_COLORS={0:"#DC2626",6:"#2563EB"};
  const SOURCE_STYLES={
    "祝日":{bg:"#FEF3C7",color:"#B45309"},
    "長期休業":{bg:"#D1FAE5",color:"#065F46"},
    "振替・その他":{bg:"#EDE9FE",color:"#6D28D9"},
  };

  const isoFromDs=ds=>{const m=(ds||"").trim().match(/^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})$/);if(!m)return null;return`${m[1]}-${m[2].padStart(2,"0")}-${m[3].padStart(2,"0")}`;};
  const makeDow=iso=>new Date(iso+"T00:00:00").getDay();
  const fmtLabel=iso=>{const d=new Date(iso+"T00:00:00");return`${d.getFullYear()}/${d.getMonth()+1}/${d.getDate()}（${DOW_LABELS[d.getDay()]}）`;};
  const fmtShort=iso=>{const d=new Date(iso+"T00:00:00");return`${d.getMonth()+1}/${d.getDate()}`;};

  const existingDates=React.useMemo(()=>new Set(entries.map(e=>e.date)),[entries]);

  const pushEntries=newEs=>{
    const fresh=newEs.filter(e=>!existingDates.has(e.date));
    if(fresh.length===0)return 0;
    setEntries(prev=>[...prev,...fresh]);
    setSelIds(prev=>{const s=new Set(prev);fresh.filter(e=>e.isWeekday).forEach(e=>s.add(e.id));return s;});
    return fresh.length;
  };

  const addFromCsv=()=>{
    if(!csvText.trim())return;
    const newEs=csvText.trim().split(/\r?\n/).flatMap((line,idx)=>{
      const parts=line.split(/[\t,]/);if(parts.length<2)return[];
      const iso=isoFromDs(parts[0]);const name=parts.slice(1).join("").trim();
      if(!iso||!name)return[];
      const dow=makeDow(iso);
      return[{id:`csv-${iso}-${idx}`,date:iso,name,dow,isWeekday:dow>=1&&dow<=5,source:"祝日"}];
    });
    const added=pushEntries(newEs);
    if(added>0)setCsvText("");
    else alert(`全て既に追加済みです（重複 ${newEs.length}件）`);
  };

  const addFromRange=()=>{
    if(!rangeStart||!rangeEnd||!rangeName.trim()){alert("開始日・終了日・名称を入力してください");return;}
    const s=new Date(rangeStart+"T00:00:00"),e=new Date(rangeEnd+"T00:00:00");
    if(s>e){alert("開始日は終了日より前にしてください");return;}
    const newEs=[];const cur=new Date(s);
    while(cur<=e){
      const dow=cur.getDay();const isWeekday=dow>=1&&dow<=5;
      if(!rangeWeekdayOnly||isWeekday){
        const iso=`${cur.getFullYear()}-${String(cur.getMonth()+1).padStart(2,"0")}-${String(cur.getDate()).padStart(2,"0")}`;
        newEs.push({id:`range-${iso}`,date:iso,name:rangeName.trim(),dow,isWeekday,source:"長期休業"});
      }
      cur.setDate(cur.getDate()+1);
    }
    const added=pushEntries(newEs);
    alert(added>0?`${added}日を追加しました（重複${newEs.length-added}件はスキップ）`:"全て既に追加済みです");
  };

  const addManual=()=>{
    if(!manualDate||!manualName.trim()){alert("日付と名称を入力してください");return;}
    if(existingDates.has(manualDate)){alert(`${fmtLabel(manualDate)} は既に追加済みです`);return;}
    const dow=makeDow(manualDate);
    const entry={id:`manual-${manualDate}-${Date.now()}`,date:manualDate,name:manualName.trim(),dow,isWeekday:dow>=1&&dow<=5,source:"振替・その他"};
    setEntries(prev=>[...prev,entry]);
    setSelIds(prev=>{const s=new Set(prev);if(entry.isWeekday)s.add(entry.id);return s;});
    setManualDate("");
  };

  const removeEntry=id=>{setEntries(prev=>prev.filter(e=>e.id!==id));setSelIds(prev=>{const s=new Set(prev);s.delete(id);return s;});};
  const toggleId=id=>{const s=new Set(selIds);s.has(id)?s.delete(id):s.add(id);setSelIds(s);};
  const toggleCid=id=>{const s=new Set(selCids);s.has(id)?s.delete(id):s.add(id);setSelCids(s);};
  const togglePeriod=p=>{const s=new Set(selPeriods);s.has(p)?s.delete(p):s.add(p);setSelPeriods(s);};

  // ── 削除タブ：登録済み休業日をnote別にグループ化 ──────────────────────────
  const blockedGroups=React.useMemo(()=>{
    const map={};
    // 祝日・長期休業のみ（行事・欠課・出張は欠課行事入力で管理）
    const isHoliday=note=>{
      if(!note)return false;
      if(note==="欠課"||note==="出張")return false;
      if(note.startsWith("行事：")||note.startsWith("その他："))return false;
      return true;
    };
    (changes||[]).filter(c=>c.isBlocked&&isHoliday(c.note)).forEach(c=>{
      const key=c.note||"(理由なし)";
      if(!map[key])map[key]={note:key,dates:new Set(),count:0};
      map[key].dates.add(c.date);
      map[key].count++;
    });
    return Object.values(map).map(g=>{
      const sorted=[...g.dates].sort();
      return{note:g.note,uniqueDays:sorted.length,totalEntries:g.count,
        minDate:sorted[0],maxDate:sorted[sorted.length-1]};
    }).sort((a,b)=>a.minDate?.localeCompare(b.minDate||"")||0);
  },[changes]);

  const toggleDelNote=note=>{const s=new Set(delSelNotes);s.has(note)?s.delete(note):s.add(note);setDelSelNotes(s);};

  const handleDelete=()=>{
    if(delSelNotes.size===0)return;
    const names=[...delSelNotes].join("・");
    if(!window.confirm(`「${names}」の登録をすべて削除しますか？\nUndo（↩ 取消）で元に戻せます。`))return;
    onRemoveBlocked(delSelNotes);
    setDelSelNotes(new Set());
    alert("削除しました。");
  };

  const sorted=[...entries].sort((a,b)=>a.date.localeCompare(b.date));
  const selected=sorted.filter(e=>selIds.has(e.id));
  const canApply=selected.length>0&&selCids.size>0&&selPeriods.size>0;
  const totalCells=selected.length*selCids.size*selPeriods.size;

  const handleApply=()=>{
    onApply(selected.map(({date,name})=>({date,name})),[...selCids],[...selPeriods].sort((a,b)=>a-b));
    onClose();
  };

  const INP={padding:"6px 10px",border:"1.5px solid #E2E8F0",borderRadius:6,fontSize:12,boxSizing:"border-box",outline:"none",fontFamily:"inherit"};
  const TAB=(k,danger=false)=>({padding:"7px 14px",border:"none",cursor:"pointer",fontSize:12,
    borderBottom:`2px solid ${inputTab===k?(danger?"#DC2626":"#1E3A5F"):"transparent"}`,
    background:"none",fontWeight:inputTab===k?700:400,
    color:inputTab===k?(danger?"#DC2626":"#1E3A5F"):"#64748B"});

  return(
    <div style={{position:"fixed",inset:0,background:"rgba(15,23,42,0.65)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:500}} onClick={onClose}>
      <div style={{background:"white",borderRadius:12,width:640,maxWidth:"96vw",maxHeight:"94vh",display:"flex",flexDirection:"column",boxShadow:"0 20px 60px rgba(0,0,0,0.3)"}} onClick={e=>e.stopPropagation()}>

        {/* ヘッダー */}
        <div style={{padding:"16px 20px 0",borderBottom:"1px solid #F1F5F9"}}>
          <div style={{display:"flex",alignItems:"flex-start",justifyContent:"space-between"}}>
            <div>
              <div style={{fontWeight:700,fontSize:16,color:"#1E3A5F",marginBottom:2}}>🗓 休業日・祝日 一括登録</div>
              <div style={{fontSize:11,color:"#94A3B8",marginBottom:10}}>
                複数の入力方法を組み合わせてリストを作り、まとめて一括登録できます
              </div>
            </div>
            {onClose&&<button onClick={onClose} style={{background:"none",border:"none",fontSize:18,cursor:"pointer",color:"#94A3B8",lineHeight:1,padding:"0 2px",flexShrink:0}}>×</button>}
          </div>
          <div style={{display:"flex",gap:0,borderBottom:"1px solid #E2E8F0"}}>
            {[["csv","📋 祝日CSV"],["range","📆 日付範囲"],["manual","📌 個別追加"]].map(([k,l])=>(
              <button key={k} onClick={()=>setInputTab(k)} style={TAB(k)}>{l}</button>
            ))}
            <button onClick={()=>setInputTab("delete")} style={{...TAB("delete",true),marginLeft:"auto"}}>
              🗑 登録済み削除
              {blockedGroups.length>0&&<span style={{marginLeft:5,background:"#FEE2E2",color:"#DC2626",borderRadius:10,padding:"0 5px",fontSize:10,fontWeight:700}}>{blockedGroups.length}</span>}
            </button>
          </div>
        </div>

        <div style={{overflowY:"auto",flex:1,padding:"14px 20px",display:"flex",flexDirection:"column",gap:12}}>

          {/* ── 削除タブ ── */}
          {inputTab==="delete"&&(
            <div style={{display:"flex",flexDirection:"column",gap:10}}>
              <div style={{fontSize:11,fontWeight:700,color:"#DC2626",marginBottom:2}}>
                登録済みの休業日・祝日を名前で選んで削除
              </div>
              {blockedGroups.length===0?(
                <div style={{textAlign:"center",color:"#CBD5E1",padding:"32px 0",fontSize:13}}>
                  登録済みの祝日・長期休業がありません<br/>
                  <span style={{fontSize:11,color:"#94A3B8"}}>行事・欠課・出張は「欠課・行事入力」で管理してください</span>
                </div>
              ):(
                <>
                  <div style={{display:"flex",gap:4,marginBottom:2}}>
                    <button onClick={()=>setDelSelNotes(new Set(blockedGroups.map(g=>g.note)))}
                      style={{padding:"2px 8px",border:"1px solid #FECACA",borderRadius:4,cursor:"pointer",fontSize:10,background:"#FFF1F2",color:"#DC2626"}}>全選択</button>
                    <button onClick={()=>setDelSelNotes(new Set())}
                      style={{padding:"2px 8px",border:"1px solid #E2E8F0",borderRadius:4,cursor:"pointer",fontSize:10,background:"#F8FAFC",color:"#374151"}}>全解除</button>
                  </div>
                  <div style={{border:"1px solid #E2E8F0",borderRadius:8,overflow:"hidden"}}>
                    {blockedGroups.map((g,i)=>{
                      const on=delSelNotes.has(g.note);
                      return(
                        <div key={g.note} style={{display:"flex",alignItems:"center",gap:10,
                          padding:"10px 14px",
                          background:on?"#FFF1F2":i%2===0?"#FAFAFA":"white",
                          borderBottom:i<blockedGroups.length-1?"1px solid #F1F5F9":"none",
                          transition:"background 0.1s"}}>
                          <input type="checkbox" checked={on} onChange={()=>toggleDelNote(g.note)}
                            style={{width:15,height:15,accentColor:"#DC2626",flexShrink:0,cursor:"pointer"}}/>
                          <div style={{flex:1,minWidth:0,cursor:"pointer"}} onClick={()=>toggleDelNote(g.note)}>
                            <div style={{fontWeight:700,fontSize:13,color:on?"#DC2626":"#1E293B",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>
                              {g.note}
                            </div>
                            <div style={{fontSize:10,color:"#94A3B8",marginTop:1}}>
                              {fmtShort(g.minDate)}{g.minDate!==g.maxDate?`〜${fmtShort(g.maxDate)}`:""}
                              　{g.uniqueDays}日間
                            </div>
                          </div>
                          <div style={{fontSize:11,color:"#94A3B8",flexShrink:0,textAlign:"right",marginRight:4}}>
                            <div>{g.totalEntries}エントリ</div>
                          </div>
                          <button onClick={()=>{
                            // この行事の日付・時限・学級をリストに読み込んで編集タブへ
                            const relEntries=(changes||[]).filter(c=>c.isBlocked&&c.note===g.note&&c.date);
                            const newEs=relEntries
                              .reduce((acc,c)=>{
                                if(!acc.find(x=>x.date===c.date)){
                                  const dow=new Date(c.date+"T00:00:00").getDay();
                                  acc.push({id:`edit-${c.date}`,date:c.date,name:g.note,dow,isWeekday:dow>=1&&dow<=5,source:"振替・その他"});
                                }
                                return acc;
                              },[]);
                            // 登録済みの時限・学級を復元
                            const regPeriods=new Set(relEntries.map(c=>c.period).filter(Boolean));
                            const regCids=new Set(relEntries.flatMap(c=>c.classIds||[]));
                            setEntries(newEs);
                            setSelIds(new Set(newEs.filter(e=>e.isWeekday).map(e=>e.id)));
                            if(regPeriods.size>0) setSelPeriods(regPeriods);
                            if(regCids.size>0) setSelCids(regCids);
                            setInputTab("manual");
                          }} style={{padding:"4px 10px",background:"#EFF6FF",color:"#1D4ED8",border:"1px solid #BFDBFE",borderRadius:5,cursor:"pointer",fontSize:11,fontWeight:700,flexShrink:0,whiteSpace:"nowrap"}}>
                            ✏ 編集
                          </button>
                        </div>
                      );
                    })}
                  </div>
                  <div style={{padding:"8px 12px",background:"#FFF8F1",border:"1px solid #FED7AA",borderRadius:7,fontSize:11,color:"#92400E"}}>
                    ⚠ 削除後は <b>↩ 取消（Undo）</b> で元に戻せます
                  </div>
                </>
              )}
            </div>
          )}

          {/* ── Tab: CSV ── */}
          {inputTab==="csv"&&(
            <div style={{display:"flex",flexDirection:"column",gap:8}}>
              <div style={{fontSize:11,color:"#374151",fontWeight:700,display:"flex",alignItems:"center",gap:8}}>
                内閣府CSVを貼り付け
                <a href="https://www8.cao.go.jp/chosei/shukujitsu/gaiyou.html" target="_blank" rel="noreferrer"
                  style={{fontSize:10,color:"#3B82F6",fontWeight:400}}>内閣府サイト ↗</a>
              </div>
              <textarea value={csvText} onChange={e=>setCsvText(e.target.value)}
                placeholder={"2026/4/29\t昭和の日\n2026/5/3\t憲法記念日\n…"}
                style={{...INP,width:"100%",height:120,resize:"vertical",fontFamily:"monospace",lineHeight:1.6}}/>
              <div style={{fontSize:10,color:"#94A3B8"}}>
                形式：<code>2026/4/29{"\t"}昭和の日</code>（タブ・カンマ区切り両対応）
              </div>
              <button onClick={addFromCsv} disabled={!csvText.trim()}
                style={{alignSelf:"flex-start",padding:"7px 20px",background:csvText.trim()?"#1E3A5F":"#E2E8F0",
                  color:csvText.trim()?"white":"#9CA3AF",border:"none",borderRadius:6,
                  cursor:csvText.trim()?"pointer":"not-allowed",fontSize:13,fontWeight:700}}>
                ＋ リストに追加
              </button>
            </div>
          )}

          {/* ── Tab: 日付範囲 ── */}
          {inputTab==="range"&&(
            <div style={{display:"flex",flexDirection:"column",gap:10}}>
              <div style={{fontSize:11,color:"#374151",fontWeight:700}}>期間を指定して一括追加（夏季・冬季・春季休業などに）</div>
              <div style={{display:"flex",gap:8,flexWrap:"wrap",alignItems:"flex-end"}}>
                <div style={{flex:1,minWidth:130}}>
                  <div style={{fontSize:10,color:"#94A3B8",marginBottom:3}}>開始日</div>
                  <input type="date" value={rangeStart} onChange={e=>setRangeStart(e.target.value)} style={{...INP,width:"100%"}}/>
                </div>
                <div style={{fontSize:16,color:"#94A3B8",paddingBottom:4}}>〜</div>
                <div style={{flex:1,minWidth:130}}>
                  <div style={{fontSize:10,color:"#94A3B8",marginBottom:3}}>終了日</div>
                  <input type="date" value={rangeEnd} onChange={e=>setRangeEnd(e.target.value)} style={{...INP,width:"100%"}}/>
                </div>
                <div style={{flex:2,minWidth:140}}>
                  <div style={{fontSize:10,color:"#94A3B8",marginBottom:3}}>名称</div>
                  <input value={rangeName} onChange={e=>setRangeName(e.target.value)} placeholder="例：夏季休業" style={{...INP,width:"100%"}}/>
                </div>
              </div>
              <label style={{display:"flex",alignItems:"center",gap:7,cursor:"pointer",fontSize:12,color:"#374151"}}>
                <input type="checkbox" checked={rangeWeekdayOnly} onChange={e=>setRangeWeekdayOnly(e.target.checked)} style={{width:14,height:14,accentColor:"#1E3A5F"}}/>
                平日のみ追加（土日はスキップ）
              </label>
              {rangeStart&&rangeEnd&&rangeStart<=rangeEnd&&(()=>{
                const s=new Date(rangeStart+"T00:00:00"),en=new Date(rangeEnd+"T00:00:00");
                let total=0,weekdays=0;const cur=new Date(s);
                while(cur<=en){const d=cur.getDay();total++;if(d>=1&&d<=5)weekdays++;cur.setDate(cur.getDate()+1);}
                return(
                  <div style={{fontSize:11,color:"#475569",background:"#F8FAFC",padding:"6px 10px",borderRadius:6,border:"1px solid #E2E8F0"}}>
                    期間内：全{total}日 / 平日{weekdays}日 → {rangeWeekdayOnly?weekdays:total}日を追加
                  </div>
                );
              })()}
              <button onClick={addFromRange} disabled={!rangeStart||!rangeEnd||!rangeName.trim()}
                style={{alignSelf:"flex-start",padding:"7px 20px",
                  background:(rangeStart&&rangeEnd&&rangeName.trim())?"#065F46":"#E2E8F0",
                  color:(rangeStart&&rangeEnd&&rangeName.trim())?"white":"#9CA3AF",
                  border:"none",borderRadius:6,cursor:(rangeStart&&rangeEnd&&rangeName.trim())?"pointer":"not-allowed",
                  fontSize:13,fontWeight:700}}>
                ＋ リストに追加
              </button>
            </div>
          )}

          {/* ── Tab: 個別追加 ── */}
          {inputTab==="manual"&&(
            <div style={{display:"flex",flexDirection:"column",gap:10}}>
              <div style={{fontSize:11,color:"#374151",fontWeight:700}}>振替休業日など、1日ずつ追加</div>
              <div style={{display:"flex",gap:8,flexWrap:"wrap",alignItems:"flex-end"}}>
                <div style={{flex:1,minWidth:150}}>
                  <div style={{fontSize:10,color:"#94A3B8",marginBottom:3}}>日付</div>
                  <input type="date" value={manualDate} onChange={e=>setManualDate(e.target.value)} style={{...INP,width:"100%"}}/>
                </div>
                <div style={{flex:2,minWidth:180}}>
                  <div style={{fontSize:10,color:"#94A3B8",marginBottom:3}}>名称</div>
                  <input value={manualName} onChange={e=>setManualName(e.target.value)} placeholder="例：振替休業日" style={{...INP,width:"100%"}}/>
                </div>
                <button onClick={addManual} disabled={!manualDate||!manualName.trim()}
                  style={{padding:"7px 20px",background:(manualDate&&manualName.trim())?"#6D28D9":"#E2E8F0",
                    color:(manualDate&&manualName.trim())?"white":"#9CA3AF",border:"none",borderRadius:6,
                    cursor:(manualDate&&manualName.trim())?"pointer":"not-allowed",fontSize:13,fontWeight:700,whiteSpace:"nowrap"}}>
                  ＋ 追加
                </button>
              </div>
              <div style={{fontSize:10,color:"#94A3B8"}}>同じ日付は重複して追加されません</div>
            </div>
          )}

          {/* ── 積み上げリスト（登録タブ共通） ── */}
          {inputTab!=="delete"&&(
            <>
              <div style={{borderTop:"2px solid #F1F5F9",paddingTop:12}}>
                <div style={{fontSize:11,fontWeight:700,color:"#374151",marginBottom:6,display:"flex",alignItems:"center",gap:8,flexWrap:"wrap"}}>
                  登録予定リスト
                  <span style={{background:"#EFF6FF",color:"#1D4ED8",borderRadius:4,padding:"1px 8px",fontSize:11,fontWeight:700}}>
                    {entries.length}件 / 選択{selIds.size}件
                  </span>
                  {entries.length>0&&(
                    <div style={{marginLeft:"auto",display:"flex",gap:4}}>
                      <button onClick={()=>setSelIds(new Set(sorted.filter(e=>e.isWeekday).map(e=>e.id)))}
                        style={{padding:"2px 7px",border:"1px solid #CBD5E1",borderRadius:4,cursor:"pointer",fontSize:10,background:"#F8FAFC",color:"#374151"}}>平日のみ</button>
                      <button onClick={()=>setSelIds(new Set(sorted.map(e=>e.id)))}
                        style={{padding:"2px 7px",border:"1px solid #CBD5E1",borderRadius:4,cursor:"pointer",fontSize:10,background:"#F8FAFC",color:"#374151"}}>全選択</button>
                      <button onClick={()=>setSelIds(new Set())}
                        style={{padding:"2px 7px",border:"1px solid #CBD5E1",borderRadius:4,cursor:"pointer",fontSize:10,background:"#F8FAFC",color:"#374151"}}>全解除</button>
                      <button onClick={()=>{setEntries([]);setSelIds(new Set());}}
                        style={{padding:"2px 7px",border:"1px solid #FECACA",borderRadius:4,cursor:"pointer",fontSize:10,background:"#FFF1F2",color:"#DC2626"}}>全削除</button>
                    </div>
                  )}
                </div>
                {entries.length===0?(
                  <div style={{textAlign:"center",color:"#CBD5E1",padding:"20px 0",fontSize:13}}>
                    上の入力方法で日付を追加してください
                  </div>
                ):(
                  <div style={{border:"1px solid #E2E8F0",borderRadius:8,maxHeight:180,overflowY:"auto"}}>
                    {sorted.map((h,i)=>{
                      const on=selIds.has(h.id);const wkColor=DOW_COLORS[h.dow];
                      const srcStyle=SOURCE_STYLES[h.source]||SOURCE_STYLES["振替・その他"];
                      return(
                        <div key={h.id} style={{display:"flex",alignItems:"center",gap:8,padding:"5px 10px",
                          background:i%2===0?"#FAFAFA":"white",borderBottom:i<sorted.length-1?"1px solid #F1F5F9":"none",
                          opacity:on?1:0.45,transition:"opacity 0.1s"}}>
                          <input type="checkbox" checked={on} onChange={()=>toggleId(h.id)}
                            style={{width:14,height:14,accentColor:"#1E3A5F",flexShrink:0,cursor:"pointer"}}/>
                          <span style={{fontSize:11,fontFamily:"monospace",color:wkColor||"#1E293B",fontWeight:700,minWidth:150,flexShrink:0}}>{fmtLabel(h.date)}</span>
                          <span style={{fontSize:12,color:"#374151",flex:1,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{h.name}</span>
                          <span style={{fontSize:9,fontWeight:700,padding:"1px 5px",borderRadius:3,background:srcStyle.bg,color:srcStyle.color,flexShrink:0}}>{h.source}</span>
                          <button onClick={()=>removeEntry(h.id)}
                            style={{background:"none",border:"none",cursor:"pointer",color:"#CBD5E1",fontSize:14,lineHeight:1,padding:"0 2px",flexShrink:0}}>×</button>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* 対象学級 */}
              <div>
                <div style={{fontSize:11,fontWeight:700,color:"#374151",marginBottom:5}}>対象学級</div>
                <div style={{display:"flex",gap:4,flexWrap:"wrap"}}>
                  <button onClick={()=>setSelCids(selCids.size===classes.length?new Set():new Set(classes.map(c=>c.id)))}
                    style={{padding:"3px 9px",border:"1.5px solid #CBD5E1",borderRadius:5,cursor:"pointer",fontSize:11,background:"#F8FAFC",color:"#374151"}}>
                    {selCids.size===classes.length?"全解除":"全選択"}
                  </button>
                  {classes.map(c=>{const on=selCids.has(c.id);return(
                    <button key={c.id} onClick={()=>toggleCid(c.id)}
                      style={{padding:"3px 10px",border:`1.5px solid ${on?"#1E3A5F":"#CBD5E1"}`,borderRadius:5,cursor:"pointer",
                        fontSize:12,fontWeight:on?700:400,background:on?"#1E3A5F":"white",color:on?"white":"#374151"}}>
                      {c.name}
                    </button>
                  );})}
                </div>
              </div>

              {/* 対象時限 */}
              <div>
                <div style={{fontSize:11,fontWeight:700,color:"#374151",marginBottom:5}}>対象時限</div>
                <div style={{display:"flex",gap:4,flexWrap:"wrap"}}>
                  <button onClick={()=>setSelPeriods(selPeriods.size===6?new Set():new Set([1,2,3,4,5,6]))}
                    style={{padding:"3px 9px",border:"1.5px solid #CBD5E1",borderRadius:5,cursor:"pointer",fontSize:11,background:"#F8FAFC",color:"#374151"}}>
                    {selPeriods.size===6?"全解除":"全選択"}
                  </button>
                  {[1,2,3,4,5,6].map(p=>{const on=selPeriods.has(p);return(
                    <button key={p} onClick={()=>togglePeriod(p)}
                      style={{padding:"3px 12px",border:`1.5px solid ${on?"#1E3A5F":"#CBD5E1"}`,borderRadius:5,cursor:"pointer",
                        fontSize:12,fontWeight:on?700:400,background:on?"#1E3A5F":"white",color:on?"white":"#374151"}}>
                      {p}限
                    </button>
                  );})}
                </div>
              </div>

              {/* サマリー */}
              <div style={{padding:"10px 14px",background:canApply?"#F0FDF4":"#F8FAFC",
                border:`1px solid ${canApply?"#86EFAC":"#E2E8F0"}`,borderRadius:8,fontSize:12}}>
                {canApply?(
                  <>
                    <span style={{fontWeight:700,color:"#15803D"}}>✓ 登録内容：</span>
                    <span style={{color:"#374151"}}><b>{selected.length}</b>日間 × <b>{selCids.size}</b>学級 × <b>{selPeriods.size}</b>時限 ＝ </span>
                    <span style={{fontWeight:700,color:"#DC2626",fontSize:14}}>{totalCells}コマ</span>
                    <span style={{color:"#94A3B8",marginLeft:6,fontSize:11}}>を空きに設定</span>
                  </>
                ):(
                  <span style={{color:"#94A3B8"}}>
                    {entries.length===0?"日付を追加してください":selIds.size===0?"登録する日付を1件以上選択してください":"学級・時限を選択してください"}
                  </span>
                )}
              </div>
            </>
          )}
        </div>

        {/* フッター */}
        <div style={{padding:"12px 20px",borderTop:"1px solid #F1F5F9",display:"flex",gap:8,alignItems:"center"}}>
          <div style={{fontSize:10,color:"#94A3B8",flex:1}}>
            ※ 既存エントリは上書きされます。Undo で元に戻せます。
          </div>
          {inputTab==="delete"?(
            <button onClick={handleDelete} disabled={delSelNotes.size===0}
              style={{padding:"10px 22px",border:"none",borderRadius:7,
                cursor:delSelNotes.size>0?"pointer":"not-allowed",fontSize:14,fontWeight:700,
                background:delSelNotes.size>0?"#DC2626":"#E2E8F0",
                color:delSelNotes.size>0?"white":"#94A3B8"}}>
              🗑 選択した休業日を削除
            </button>
          ):(
            <button onClick={handleApply} disabled={!canApply}
              style={{padding:"10px 24px",border:"none",borderRadius:7,
                cursor:canApply?"pointer":"not-allowed",fontSize:14,fontWeight:700,
                background:canApply?"#1E3A5F":"#E2E8F0",
                color:canApply?"white":"#94A3B8"}}>
              🗓 一括登録
            </button>
          )}
          {<button onClick={onClose}
            style={{padding:"10px 16px",background:"#F1F5F9",color:"#64748B",border:"none",borderRadius:7,cursor:"pointer",fontSize:14,fontWeight:700}}>
            ✕ 閉じる
          </button>}
        </div>
      </div>
    </div>
  );
}
// ── 時限パターン一括設定タブ ────────────────────────────────────────────────
function PeriodPatternBatchTab({wkStart,onApplyPattern,onClose}){
  const DAYS=["月","火","水","木","金"];
  const PERIODS=[1,2,3,4,5,6];
  const addDLocal=(ds,n)=>{const d=new Date(ds+"T00:00:00");d.setDate(d.getDate()+n);return`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;};
  const fmtMDLocal=ds=>{const d=new Date(ds+"T00:00:00");return`${d.getMonth()+1}/${d.getDate()}`;};
  const wkDates5=Array.from({length:5},(_,i)=>addDLocal(wkStart,i));

  const[selDates,setSelDates]=React.useState(new Set());
  const[selPeriods,setSelPeriods]=React.useState(new Set());
  const[patternDay,setPatternDay]=React.useState(null);
  const[patternPeriod,setPatternPeriod]=React.useState(null); // null=同じ時限
  const[resetMode,setResetMode]=React.useState(false);

  const toggleDate=dt=>{const s=new Set(selDates);s.has(dt)?s.delete(dt):s.add(dt);setSelDates(s);};
  const togglePeriod=p=>{const s=new Set(selPeriods);s.has(p)?s.delete(p):s.add(p);setSelPeriods(s);};

  const canApply=selDates.size>0&&selPeriods.size>0&&(resetMode||patternDay!==null);

  const handleApply=()=>{
    if(!canApply)return;
    // patternPeriodがnullの場合は各時限と同じ時限を使う
    const sortedPeriods=[...selPeriods].sort((a,b)=>a-b);
    if(resetMode){
      onApplyPattern([...selDates].sort(),null,sortedPeriods,null);
    }else if(patternPeriod!==null){
      // 全対象時限を同じ「patternDay patternPeriod限」にマップ
      onApplyPattern([...selDates].sort(),patternDay,sortedPeriods,patternPeriod);
    }else{
      // 各時限と同じ時限番号で patternDay を使う
      onApplyPattern([...selDates].sort(),patternDay,sortedPeriods,null);
    }
    onClose();
  };

  return(
    <div style={{display:"flex",flexDirection:"column",gap:14}}>
      <div style={{fontSize:12,color:"#64748B",background:"#F0F9FF",border:"1px solid #BAE6FD",borderRadius:7,padding:"8px 12px"}}>
        💡 特定の時限だけ別の曜日の授業を使いたいとき（例：6/1の6限を火曜日課で実施）に使います。
      </div>

      {/* モード選択 */}
      <div style={{display:"flex",gap:8}}>
        {[{v:false,l:"📅 時限パターンを設定",c:"#1D4ED8",bg:"#EFF6FF"},{v:true,l:"♻ パターンをリセット",c:"#15803D",bg:"#F0FDF4"}].map(({v,l,c,bg})=>(
          <button key={String(v)} onClick={()=>setResetMode(v)}
            style={{flex:1,padding:"9px",border:`2px solid ${resetMode===v?c:"#E2E8F0"}`,borderRadius:8,cursor:"pointer",
              fontSize:12,fontWeight:resetMode===v?700:400,background:resetMode===v?bg:"white",color:resetMode===v?c:"#64748B"}}>
            {l}
          </button>
        ))}
      </div>

      {/* ④ 対象日 */}
      <div>
        <div style={{fontSize:11,fontWeight:700,color:"#374151",marginBottom:6}}>対象日（今週）</div>
        <div style={{display:"flex",gap:4,flexWrap:"wrap"}}>
          <button onClick={()=>setSelDates(selDates.size===5?new Set():new Set(wkDates5))}
            style={{padding:"3px 10px",border:"1.5px solid #CBD5E1",borderRadius:5,cursor:"pointer",fontSize:11,background:"#F8FAFC",color:"#374151"}}>
            {selDates.size===5?"全解除":"全選択"}
          </button>
          {wkDates5.map((dt,i)=>{const on=selDates.has(dt);return(
            <button key={dt} onClick={()=>toggleDate(dt)}
              style={{padding:"4px 10px",border:`1.5px solid ${on?"#1E3A5F":"#CBD5E1"}`,borderRadius:5,cursor:"pointer",
                fontSize:12,fontWeight:on?700:400,background:on?"#1E3A5F":"white",color:on?"white":"#374151",
                display:"flex",flexDirection:"column",alignItems:"center",lineHeight:1.3}}>
              <span style={{fontWeight:700}}>{DAYS[i]}</span>
              <span style={{fontSize:10}}>{fmtMDLocal(dt)}</span>
            </button>
          );})}
        </div>
      </div>

      {/* ③ 対象の時限 */}
      <div>
        <div style={{fontSize:11,fontWeight:700,color:"#374151",marginBottom:6}}>対象時限（変更する時限）</div>
        <div style={{display:"flex",gap:4,flexWrap:"wrap"}}>
          <button onClick={()=>setSelPeriods(selPeriods.size===6?new Set():new Set([1,2,3,4,5,6]))}
            style={{padding:"4px 10px",border:"1.5px solid #CBD5E1",borderRadius:5,cursor:"pointer",fontSize:11,background:"#F8FAFC",color:"#374151"}}>
            {selPeriods.size===6?"全解除":"全選択"}
          </button>
          {PERIODS.map(p=>{const on=selPeriods.has(p);return(
            <button key={p} onClick={()=>togglePeriod(p)}
              style={{padding:"4px 12px",border:`1.5px solid ${on?"#1E3A5F":"#CBD5E1"}`,borderRadius:5,cursor:"pointer",
                fontSize:12,fontWeight:on?700:400,background:on?"#1E3A5F":"white",color:on?"white":"#374151"}}>
              {p}限
            </button>
          );})}
        </div>
      </div>

      {/* ① どの曜日 ② 何限 */}
      {!resetMode&&(
        <div style={{display:"flex",flexDirection:"column",gap:10}}>
          <div>
            <div style={{fontSize:11,fontWeight:700,color:"#374151",marginBottom:6}}>どの曜日の授業を使うか</div>
            <div style={{display:"flex",gap:6}}>
              {DAYS.map(d=>(
                <button key={d} onClick={()=>setPatternDay(d)}
                  style={{flex:1,padding:"8px",border:`1.5px solid ${patternDay===d?"#1D4ED8":"#CBD5E1"}`,borderRadius:6,cursor:"pointer",
                    fontSize:13,fontWeight:patternDay===d?700:400,
                    background:patternDay===d?"#1D4ED8":"white",color:patternDay===d?"white":"#374151"}}>
                  {d}曜
                </button>
              ))}
            </div>
          </div>
          <div>
            <div style={{fontSize:11,fontWeight:700,color:"#374151",marginBottom:6}}>
              何限の授業を使うか
              <span style={{fontWeight:400,color:"#94A3B8",marginLeft:6}}>（「同じ時限」= 1限なら1限、6限なら6限）</span>
            </div>
            <div style={{display:"flex",gap:4,flexWrap:"wrap"}}>
              <button onClick={()=>setPatternPeriod(null)}
                style={{padding:"5px 12px",border:`1.5px solid ${patternPeriod===null?"#1D4ED8":"#CBD5E1"}`,borderRadius:5,cursor:"pointer",
                  fontSize:12,fontWeight:patternPeriod===null?700:400,
                  background:patternPeriod===null?"#1D4ED8":"white",color:patternPeriod===null?"white":"#374151"}}>
                同じ時限
              </button>
              {PERIODS.map(p=>(
                <button key={p} onClick={()=>setPatternPeriod(p)}
                  style={{padding:"5px 12px",border:`1.5px solid ${patternPeriod===p?"#1D4ED8":"#CBD5E1"}`,borderRadius:5,cursor:"pointer",
                    fontSize:12,fontWeight:patternPeriod===p?700:400,
                    background:patternPeriod===p?"#1D4ED8":"white",color:patternPeriod===p?"white":"#374151"}}>
                  {p}限
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* サマリー */}
      <div style={{padding:"8px 12px",background:canApply?"#EFF6FF":"#F8FAFC",
        border:`1px solid ${canApply?"#BFDBFE":"#E2E8F0"}`,borderRadius:7,fontSize:12}}>
        {canApply?(
          <span style={{color:"#1D4ED8",fontWeight:700}}>
            {resetMode
              ?`♻ ${[...selDates].map(dt=>{const i=wkDates5.indexOf(dt);return DAYS[i]+"曜";}).join("・")} の ${[...selPeriods].sort().map(p=>p+"限").join("・")} をリセット`
              :`📅 ${[...selDates].map(dt=>{const i=wkDates5.indexOf(dt);return DAYS[i]+"曜";}).join("・")} の ${[...selPeriods].sort().map(p=>p+"限").join("・")} → ${patternDay}曜${patternPeriod!==null?patternPeriod+"限の":"同じ時限の"}授業を実施`}
          </span>
        ):(
          <span style={{color:"#94A3B8"}}>
            {!resetMode&&patternDay===null?"使用する曜日を選択してください":selDates.size===0?"対象日を選択してください":"対象時限を選択してください"}
          </span>
        )}
      </div>

      <button onClick={handleApply} disabled={!canApply}
        style={{width:"100%",padding:"11px",border:"none",borderRadius:7,cursor:canApply?"pointer":"not-allowed",
          fontSize:14,fontWeight:700,
          background:canApply?(resetMode?"#15803D":"#1D4ED8"):"#E2E8F0",
          color:canApply?"white":"#94A3B8"}}>
        {resetMode?"♻ パターンをリセット":"📅 時限パターンを設定"}
      </button>
    </div>
  );
}

function UrlManageModal({classes,onClose}){
  const BASE_URL=window.location.origin+window.location.pathname;
  const[tokens,setTokens]=React.useState([]);
  const[loading,setLoading]=React.useState(true);
  const[generating,setGenerating]=React.useState(null);
  const[copied,setCopied]=React.useState(null);
  const[qrUrl,setQrUrl]=React.useState(null); // QRコード表示中のURL

  React.useEffect(()=>{
    sbListTokens().then(rows=>{setTokens(Array.isArray(rows)?rows:[]);setLoading(false);});
  },[]);

  const genUrl=async(type,classId=null)=>{
    const key=type+(classId||"");
    setGenerating(key);
    const token=genToken();
    await sbSaveToken(token,type,classId);
    const longUrl=`${BASE_URL}?t=${token}`;
    const shortUrl=await shortenUrl(longUrl);
    const newRow={token,type,class_id:classId,short_url:shortUrl,created_at:new Date().toISOString()};
    setTokens(p=>[newRow,...p]);
    setGenerating(null);
  };

  const deleteToken=async(token)=>{
    await sbDeleteToken(token);
    setTokens(p=>p.filter(r=>r.token!==token));
  };

  const copyUrl=async(url,key)=>{
    await navigator.clipboard.writeText(url);
    setCopied(key);
    setTimeout(()=>setCopied(null),2000);
  };

  // QRコードをGoogle Charts APIで生成
  const qrSrc=url=>`https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(url)}`;

  const OVL={position:"fixed",inset:0,background:"rgba(15,23,42,0.65)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:500};
  const BOX={background:"white",borderRadius:12,width:600,maxWidth:"97vw",maxHeight:"92vh",display:"flex",flexDirection:"column",boxShadow:"0 20px 60px rgba(0,0,0,0.3)"};

  const studentTokens=tokens.filter(t=>t.type==="student");
  const teacherTokens=tokens.filter(t=>t.type==="teacher");

  const UrlRow=({r,color="#1D4ED8",bg="#F0F9FF",border="#BAE6FD"})=>{
    const url=r.short_url||`${BASE_URL}?t=${r.token}`;
    return(
      <div style={{padding:"10px 12px",background:bg,borderRadius:7,border:`1px solid ${border}`,marginBottom:6}}>
        <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:6}}>
          <div style={{flex:1,fontSize:11,color,wordBreak:"break-all",fontFamily:"monospace"}}>{url}</div>
          <button onClick={()=>copyUrl(url,r.token)}
            style={{padding:"3px 10px",background:copied===r.token?"#15803D":color,color:"white",border:"none",borderRadius:5,cursor:"pointer",fontSize:11,whiteSpace:"nowrap",flexShrink:0}}>
            {copied===r.token?"✓ コピー済":"📋 コピー"}
          </button>
          <button onClick={()=>setQrUrl(qrUrl===url?null:url)}
            style={{padding:"3px 10px",background:qrUrl===url?"#374151":"#F1F5F9",color:qrUrl===url?"white":"#374151",border:"none",borderRadius:5,cursor:"pointer",fontSize:11,flexShrink:0}}>
            📱 QR
          </button>
          <button onClick={()=>deleteToken(r.token)}
            style={{padding:"3px 8px",background:"#FEE2E2",color:"#DC2626",border:"none",borderRadius:5,cursor:"pointer",fontSize:11,flexShrink:0}}>
            🗑
          </button>
        </div>
        {qrUrl===url&&(
          <div style={{textAlign:"center",padding:"8px 0"}}>
            <img src={qrSrc(url)} alt="QRコード" style={{width:160,height:160,border:"1px solid #E2E8F0",borderRadius:6}}/>
            <div style={{fontSize:10,color:"#94A3B8",marginTop:4}}>スマートフォンでスキャンしてください</div>
            <a href={qrSrc(url)} download="qrcode.png"
              style={{display:"inline-block",marginTop:4,fontSize:11,color:color,textDecoration:"underline",cursor:"pointer"}}>
              📥 QR画像をダウンロード
            </a>
          </div>
        )}
      </div>
    );
  };

  return(
    <div style={OVL} onClick={onClose}>
      <div style={BOX} onClick={e=>e.stopPropagation()}>
        <div style={{padding:"14px 20px",borderBottom:"1px solid #F1F5F9",display:"flex",alignItems:"center",justifyContent:"space-between"}}>
          <div style={{fontWeight:700,fontSize:16,color:"#1E3A5F"}}>🔗 URL管理</div>
          <button onClick={onClose} style={{background:"none",border:"none",fontSize:18,cursor:"pointer",color:"#94A3B8"}}>×</button>
        </div>

        <div style={{overflowY:"auto",flex:1,padding:"16px 20px",display:"flex",flexDirection:"column",gap:20}}>

          {/* 教員用URL */}
          <div>
            <div style={{fontWeight:700,fontSize:13,color:"#1E3A5F",marginBottom:8}}>👨‍🏫 教員用URL（教員ビュー・ログイン不要）</div>
            {teacherTokens.length===0?(
              <div style={{color:"#94A3B8",fontSize:12,marginBottom:8}}>まだ発行されていません</div>
            ):(
              <div style={{marginBottom:8}}>
                {teacherTokens.map(r=><UrlRow key={r.token} r={r} color="#1D4ED8" bg="#F0F9FF" border="#BAE6FD"/>)}
              </div>
            )}
            <button onClick={()=>genUrl("teacher")} disabled={generating==="teacher"}
              style={{padding:"7px 16px",background:"#1D4ED8",color:"white",border:"none",borderRadius:7,cursor:"pointer",fontSize:12,fontWeight:700}}>
              {generating==="teacher"?"生成中...":"＋ 教員用URLを発行"}
            </button>
          </div>

          {/* 生徒用URL */}
          <div>
            <div style={{fontWeight:700,fontSize:13,color:"#1E3A5F",marginBottom:8}}>🎒 生徒用URL（クラス別・ログイン不要）</div>
            <div style={{display:"flex",flexDirection:"column",gap:10}}>
              {classes.map(cls=>{
                const clsTokens=studentTokens.filter(t=>t.class_id===cls.id);
                return(
                  <div key={cls.id} style={{border:"1px solid #E2E8F0",borderRadius:8,padding:"10px 12px"}}>
                    <div style={{fontWeight:700,fontSize:12,color:"#374151",marginBottom:6}}>{cls.name}</div>
                    {clsTokens.length===0?(
                      <div style={{color:"#94A3B8",fontSize:11,marginBottom:6}}>未発行</div>
                    ):(
                      <div style={{marginBottom:6}}>
                        {clsTokens.map(r=><UrlRow key={r.token} r={r} color="#15803D" bg="#F0FDF4" border="#BBF7D0"/>)}
                      </div>
                    )}
                    <button onClick={()=>genUrl("student",cls.id)} disabled={generating===("student"+cls.id)}
                      style={{padding:"4px 12px",background:"#16A34A",color:"white",border:"none",borderRadius:5,cursor:"pointer",fontSize:11,fontWeight:700}}>
                      {generating===("student"+cls.id)?"生成中...":"＋ URL発行"}
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        <div style={{padding:"12px 20px",borderTop:"1px solid #F1F5F9"}}>
          <div style={{fontSize:11,color:"#94A3B8",marginBottom:8}}>※ URLを知っている人はログインなしでアクセスできます。不要になったURLは削除してください。</div>
          <button onClick={onClose}
            style={{width:"100%",padding:"10px",background:"#F1F5F9",color:"#64748B",border:"none",borderRadius:7,cursor:"pointer",fontSize:14,fontWeight:700}}>
            閉じる
          </button>
        </div>
      </div>
    </div>
  );
}

// ── ② BatchBlockModal ─────────────────────────────────────────────────────────
function BatchBlockModal({classes,wkStart,changes,onApply,onRemoveBlocked,onApplyPattern,initialTab="input",onClose}){
  const addDLocal=(ds,n)=>{const d=new Date(ds+"T00:00:00");d.setDate(d.getDate()+n);return`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;};
  const fmtMDLocal=ds=>{const d=new Date(ds+"T00:00:00");return`${d.getMonth()+1}/${d.getDate()}`;};
  const fmtDateFull=ds=>{const d=new Date(ds+"T00:00:00");const days=["日","月","火","水","木","金","土"];return`${d.getMonth()+1}/${d.getDate()}（${days[d.getDay()]}）`;};
  const DAYS_B=["月","火","水","木","金"];
  const wkDates5=Array.from({length:5},(_,i)=>addDLocal(wkStart,i));
  const cn=id=>classes.find(c=>c.id===id)?.name||id;

  // タブ: "input" | "history"
  const[tab,setTab]=React.useState(initialTab);

  // ── 入力フォーム state ──
  const[selDates,setSelDates]=React.useState(new Set()); // デフォルト全解除
  const[selCids,setSelCids]=React.useState(new Set(classes.map(c=>c.id)));
  const[selPeriods,setSelPeriods]=React.useState(new Set([1,2,3,4,5,6]));
  const[mode,setMode]=React.useState("block");
  const[reasonType,setReasonType]=React.useState("欠課");
  const[eventName,setEventName]=React.useState("");
  const[otherName,setOtherName]=React.useState("");
  const[editingNote,setEditingNote]=React.useState(null); // 編集中の元note

  const reason=reasonType==="欠課"?"欠課":reasonType==="行事"?`行事：${eventName}`:`その他：${otherName}`;

  const toggleDate=dt=>{const s=new Set(selDates);s.has(dt)?s.delete(dt):s.add(dt);setSelDates(s);};
  const toggleCid=id=>{const s=new Set(selCids);s.has(id)?s.delete(id):s.add(id);setSelCids(s);};
  const togglePeriod=p=>{const s=new Set(selPeriods);s.has(p)?s.delete(p):s.add(p);setSelPeriods(s);};

  const gradeGroups=React.useMemo(()=>{
    const groups={};
    classes.forEach(c=>{
      const m=c.name.match(/^(\d+)年/)||c.name.match(/^([^\d]+)/);
      const key=m?m[1]+"年":c.name;
      if(!groups[key])groups[key]=[];
      groups[key].push(c.id);
    });
    return groups;
  },[classes]);

  const canApply=selDates.size>0&&selCids.size>0&&selPeriods.size>0;

  const handleApply=()=>{
    if(!canApply)return;
    onApply([...selDates].sort(),[...selCids],[...selPeriods].sort((a,b)=>a-b),reason,mode==="remove",editingNote);
    setEditingNote(null);
    onClose();
  };

  // ── 履歴: changes から isBlocked エントリをグループ化 ──
  const history=React.useMemo(()=>{
    // 行事・欠課・出張のみ（祝日・長期休業はHolidayImportModalで管理）
    const isEventEntry=note=>{
      if(!note)return true;
      if(note==="欠課"||note==="出張")return true;
      if(note.startsWith("行事：")||note.startsWith("その他："))return true;
      return false;
    };
    const blocked=(changes||[]).filter(c=>c.isBlocked&&c.date&&c.classIds?.length&&isEventEntry(c.note));
    // note ごとにグループ化
    const map={};
    blocked.forEach(c=>{
      const key=c.note||"（理由なし）";
      if(!map[key])map[key]={note:key,dates:new Set(),cids:new Set(),periods:new Set(),entries:[]};
      map[key].dates.add(c.date);
      (c.classIds||[]).forEach(id=>map[key].cids.add(id));
      if(c.period)map[key].periods.add(c.period);
      map[key].entries.push(c);
    });
    return Object.values(map).sort((a,b)=>[...a.dates][0]<[...b.dates][0]?1:-1);
  },[changes]);

  // 履歴エントリをフォームに読み込んで編集
  const loadForEdit=(entry)=>{
    const dateArr=[...entry.dates].sort();
    // 今週の日付のみ選択（今週以外は表示しないが選択状態は保持）
    setSelDates(new Set(dateArr.filter(d=>wkDates5.includes(d))));
    setSelCids(new Set(entry.cids));
    setSelPeriods(new Set(entry.periods));
    setMode("block");
    setEditingNote(entry.note); // 編集元のnoteを記憶
    const note=entry.note||"欠課";
    if(note==="欠課"){setReasonType("欠課");setEventName("");setOtherName("");}
    else if(note.startsWith("行事：")){setReasonType("行事");setEventName(note.replace("行事：",""));setOtherName("");}
    else{setReasonType("その他");setOtherName(note.replace("その他：",""));setEventName("");}
    setTab("input");
  };

  const deleteEntry=(entry)=>{
    if(!window.confirm(`「${entry.note}」の設定（${entry.entries.length}コマ）を全て削除しますか？`))return;
    onRemoveBlocked(new Set([entry.note]));
  };

  const OVL={position:"fixed",inset:0,background:"rgba(15,23,42,0.65)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:500};
  const BOX={background:"white",borderRadius:12,width:520,maxWidth:"97vw",maxHeight:"94vh",display:"flex",flexDirection:"column",boxShadow:"0 20px 60px rgba(0,0,0,0.3)"};

  return(
    <div style={OVL} onClick={onClose}>
      <div style={BOX} onClick={e=>e.stopPropagation()}>

        {/* ヘッダー */}
        <div style={{padding:"14px 20px 0",borderBottom:"1px solid #F1F5F9",flexShrink:0}}>
          <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:10}}>
            <div style={{fontWeight:700,fontSize:16,color:"#1E3A5F"}}>🗓 欠課・行事入力</div>
            <button onClick={onClose} style={{background:"none",border:"none",fontSize:18,cursor:"pointer",color:"#94A3B8",lineHeight:1}}>×</button>
          </div>
          <div style={{display:"flex",gap:0}}>
            {[{v:"input",l:"✏ 入力"},{v:"pattern",l:"📅 時限パターン"},{v:"history",l:`📋 履歴・編集${history.length>0?" ("+history.length+")":""}`}].map(({v,l})=>(
              <button key={v} onClick={()=>setTab(v)}
                style={{padding:"7px 18px",border:"none",borderRadius:"6px 6px 0 0",cursor:"pointer",fontSize:12,
                  fontWeight:tab===v?700:400,background:tab===v?"#1E3A5F":"#F1F5F9",
                  color:tab===v?"white":"#64748B"}}>
                {l}
              </button>
            ))}
          </div>
        </div>

        <div style={{overflowY:"auto",flex:1,padding:"16px 20px",minHeight:0}}>
          {/* ── 入力タブ ── */}
          {tab==="input"&&(<>
            {/* 編集中バナー */}
          {editingNote&&(
            <div style={{marginBottom:12,padding:"8px 12px",background:"#EFF6FF",border:"1px solid #BFDBFE",borderRadius:7,fontSize:12,color:"#1D4ED8",display:"flex",alignItems:"center",gap:8}}>
              <span>✏️ 編集中：<strong>{editingNote}</strong></span>
              <span style={{color:"#94A3B8",fontSize:11}}>保存すると全データが上書きされます</span>
              <button onClick={()=>{setEditingNote(null);setSelDates(new Set());}}
                style={{marginLeft:"auto",padding:"2px 8px",background:"#F1F5F9",border:"none",borderRadius:4,cursor:"pointer",fontSize:11,color:"#64748B"}}>
                編集解除
              </button>
            </div>
          )}
          {/* 設定タイプ */}
            <div style={{marginBottom:16,display:"flex",gap:8}}>
              {[{v:"block",l:"🚫 空きに設定",c:"#DC2626",bg:"#FEF2F2"},{v:"remove",l:"♻ 設定を解除",c:"#15803D",bg:"#F0FDF4"}].map(({v,l,c,bg})=>(
                <button key={v} onClick={()=>setMode(v)}
                  style={{flex:1,padding:"10px",border:`2px solid ${mode===v?c:"#E2E8F0"}`,borderRadius:8,cursor:"pointer",
                    fontSize:13,fontWeight:mode===v?700:400,background:mode===v?bg:"white",color:mode===v?c:"#64748B"}}>
                  {l}
                </button>
              ))}
            </div>

            {/* 理由 */}
            {mode==="block"&&(
              <div style={{marginBottom:14,padding:"12px 14px",background:"#F8FAFC",borderRadius:8,border:"1px solid #E2E8F0"}}>
                <div style={{fontSize:11,fontWeight:700,color:"#374151",marginBottom:8}}>理由</div>
                <div style={{display:"flex",gap:8,marginBottom:10}}>
                  {["欠課","行事","その他"].map(r=>(
                    <button key={r} onClick={()=>setReasonType(r)}
                      style={{flex:1,padding:"8px 6px",borderRadius:6,fontSize:13,cursor:"pointer",
                        border:"1.5px solid",fontWeight:reasonType===r?700:400,
                        borderColor:reasonType===r?"#374151":"#D1D5DB",
                        background:reasonType===r?"#374151":"white",color:reasonType===r?"white":"#374151"}}>
                      {r==="行事"?"🎌 "+r:r==="欠課"?"📋 "+r:"📝 "+r}
                    </button>
                  ))}
                </div>
                {reasonType==="行事"&&(
                  <input value={eventName} onChange={e=>setEventName(e.target.value)}
                    placeholder="行事名を入力（例：体育祭、文化祭）" autoFocus
                    style={{width:"100%",padding:"8px 10px",border:"1.5px solid #E2E8F0",borderRadius:6,fontSize:13,boxSizing:"border-box"}}/>
                )}
                {reasonType==="その他"&&(
                  <input value={otherName} onChange={e=>setOtherName(e.target.value)}
                    placeholder="理由を入力" autoFocus
                    style={{width:"100%",padding:"8px 10px",border:"1.5px solid #E2E8F0",borderRadius:6,fontSize:13,boxSizing:"border-box"}}/>
                )}
              </div>
            )}

            {/* 対象日 */}
            <div style={{marginBottom:14}}>
              <div style={{fontSize:11,fontWeight:700,color:"#374151",marginBottom:6}}>対象日（今週）</div>
              <div style={{display:"flex",gap:4,flexWrap:"wrap"}}>
                <button onClick={()=>setSelDates(selDates.size===5?new Set():new Set(wkDates5))}
                  style={{padding:"3px 10px",border:"1.5px solid #CBD5E1",borderRadius:5,cursor:"pointer",fontSize:11,background:"#F8FAFC",color:"#374151"}}>
                  {selDates.size===5?"全解除":"全選択"}
                </button>
                {wkDates5.map((dt,i)=>{
                  const on=selDates.has(dt);
                  return(
                    <button key={dt} onClick={()=>toggleDate(dt)}
                      style={{padding:"4px 10px",border:`1.5px solid ${on?"#1E3A5F":"#CBD5E1"}`,borderRadius:5,cursor:"pointer",
                        fontSize:12,fontWeight:on?700:400,background:on?"#1E3A5F":"white",color:on?"white":"#374151",
                        display:"flex",flexDirection:"column",alignItems:"center",lineHeight:1.3}}>
                      <span style={{fontWeight:700}}>{DAYS_B[i]}</span>
                      <span style={{fontSize:10}}>{fmtMDLocal(dt)}</span>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* 対象時限 */}
            <div style={{marginBottom:14}}>
              <div style={{fontSize:11,fontWeight:700,color:"#374151",marginBottom:6}}>対象時限</div>
              <div style={{display:"flex",gap:4,flexWrap:"wrap"}}>
                <button onClick={()=>setSelPeriods(selPeriods.size===6?new Set():new Set([1,2,3,4,5,6]))}
                  style={{padding:"3px 10px",border:"1.5px solid #CBD5E1",borderRadius:5,cursor:"pointer",fontSize:11,background:"#F8FAFC",color:"#374151"}}>
                  {selPeriods.size===6?"全解除":"全時限"}
                </button>
                {[1,2,3,4,5,6].map(p=>{const on=selPeriods.has(p);return(
                  <button key={p} onClick={()=>togglePeriod(p)}
                    style={{padding:"4px 12px",border:`1.5px solid ${on?"#1E3A5F":"#CBD5E1"}`,borderRadius:5,cursor:"pointer",
                      fontSize:12,fontWeight:on?700:400,background:on?"#1E3A5F":"white",color:on?"white":"#374151"}}>
                    {p}限
                  </button>
                );})}
              </div>
            </div>

            {/* 対象学級 */}
            <div style={{marginBottom:14}}>
              <div style={{fontSize:11,fontWeight:700,color:"#374151",marginBottom:6}}>対象学級</div>
              <div style={{display:"flex",gap:4,flexWrap:"wrap",marginBottom:6}}>
                <button onClick={()=>setSelCids(selCids.size===classes.length?new Set():new Set(classes.map(c=>c.id)))}
                  style={{padding:"3px 10px",border:"1.5px solid #CBD5E1",borderRadius:5,cursor:"pointer",fontSize:11,background:"#1E3A5F",color:"white",fontWeight:700}}>
                  {selCids.size===classes.length?"全解除":"全校"}
                </button>
                {Object.entries(gradeGroups).map(([grade,ids])=>(
                  <button key={grade} onClick={()=>{
                    const allIn=ids.every(id=>selCids.has(id));
                    const s=new Set(selCids);ids.forEach(id=>allIn?s.delete(id):s.add(id));setSelCids(s);
                  }}
                  style={{padding:"3px 10px",border:"1.5px solid #CBD5E1",borderRadius:5,cursor:"pointer",fontSize:11,
                    background:ids.every(id=>selCids.has(id))?"#475569":"#F8FAFC",
                    color:ids.every(id=>selCids.has(id))?"white":"#374151"}}>
                    {grade}
                  </button>
                ))}
              </div>
              <div style={{display:"flex",gap:4,flexWrap:"wrap"}}>
                {classes.map(c=>{const on=selCids.has(c.id);return(
                  <button key={c.id} onClick={()=>toggleCid(c.id)}
                    style={{padding:"4px 12px",border:`1.5px solid ${on?"#1E3A5F":"#CBD5E1"}`,borderRadius:5,cursor:"pointer",
                      fontSize:12,fontWeight:on?700:400,background:on?"#1E3A5F":"white",color:on?"white":"#374155"}}>
                    {c.name}
                  </button>
                );})}
              </div>
            </div>

            {/* プレビュー */}
            <div style={{padding:"10px 14px",background:mode==="block"?"#FEF2F2":"#F0FDF4",border:`1px solid ${mode==="block"?"#FECACA":"#BBF7D0"}`,borderRadius:8,fontSize:12,color:"#374151"}}>
              <span style={{fontWeight:700,color:mode==="block"?"#DC2626":"#15803D"}}>{mode==="block"?"🚫 空きに設定":"♻ 解除"}：</span>
              <span> {selDates.size}日 × {selCids.size}学級 × {selPeriods.size}時限 = </span>
              <span style={{fontWeight:700}}>{selDates.size*selCids.size*selPeriods.size}コマ</span>
              {mode==="block"&&<span style={{color:"#6B7280",marginLeft:6}}>（{reason||"欠課"}）</span>}
            </div>
          </>)}

          {/* ── 時限パターンタブ ── */}
          {tab==="pattern"&&(
            <PeriodPatternBatchTab
              wkStart={wkStart}
              onApplyPattern={onApplyPattern}
              onClose={onClose}
            />
          )}

          {/* ── 履歴・編集タブ ── */}
          {tab==="history"&&(
            <div>
              {history.length===0?(
                <div style={{textAlign:"center",color:"#94A3B8",padding:"40px 0",fontSize:13}}>
                  空き設定の履歴がありません
                </div>
              ):(
                <div style={{display:"flex",flexDirection:"column",gap:10}}>
                  {history.map((entry,i)=>{
                    const sortedDates=[...entry.dates].sort();
                    const sortedPeriods=[...entry.periods].sort((a,b)=>a-b);
                    const sortedCids=[...entry.cids];
                    return(
                      <div key={i} style={{border:"1px solid #E2E8F0",borderRadius:8,overflow:"hidden"}}>
                        {/* ヘッダー行 */}
                        <div style={{padding:"10px 14px",background:"#F8FAFC",display:"flex",alignItems:"center",gap:8}}>
                          <span style={{fontWeight:700,fontSize:13,color:"#1E293B",flex:1}}>
                            {entry.note.startsWith("行事：")?`🎌 ${entry.note.replace("行事：","")}`
                              :entry.note==="欠課"?"📋 欠課"
                              :`📝 ${entry.note.replace("その他：","")}`}
                          </span>
                          <span style={{fontSize:11,color:"#94A3B8"}}>{entry.entries.length}コマ</span>
                          <button onClick={()=>loadForEdit(entry)}
                            style={{padding:"4px 10px",background:"#EFF6FF",color:"#1D4ED8",border:"1px solid #BFDBFE",borderRadius:5,cursor:"pointer",fontSize:11,fontWeight:700}}>
                            ✏️ 編集
                          </button>
                          <button onClick={()=>deleteEntry(entry)}
                            style={{padding:"4px 10px",background:"#FEF2F2",color:"#DC2626",border:"1px solid #FECACA",borderRadius:5,cursor:"pointer",fontSize:11,fontWeight:700}}>
                            🗑 削除
                          </button>
                        </div>
                        {/* 詳細 */}
                        <div style={{padding:"8px 14px",fontSize:11,color:"#475569",display:"flex",gap:12,flexWrap:"wrap"}}>
                          <span>📅 {sortedDates.map(fmtDateFull).join("、")}</span>
                          <span>⏰ {sortedPeriods.map(p=>p+"限").join("・")}</span>
                          <span>🏫 {sortedCids.map(cn).join("・")}</span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>

        {/* フッター */}
        {tab==="input"&&(
          <div style={{padding:"12px 20px",borderTop:"1px solid #F1F5F9",display:"flex",gap:8}}>
            <button onClick={handleApply} disabled={!canApply}
              style={{flex:1,padding:"10px",border:"none",borderRadius:7,cursor:canApply?"pointer":"not-allowed",
                fontSize:14,fontWeight:700,
                background:!canApply?"#E2E8F0":mode==="block"?"#DC2626":"#15803D",
                color:!canApply?"#94A3B8":"white"}}>
              {mode==="block"?"🚫 一括で空きに設定":"♻ 設定を一括解除"}
            </button>
            <button onClick={onClose}
              style={{padding:"10px 18px",background:"#F1F5F9",color:"#64748B",border:"none",borderRadius:7,cursor:"pointer",fontSize:14,fontWeight:700}}>
              ✕ 閉じる
            </button>
          </div>
        )}
        {tab==="history"&&(
          <div style={{padding:"12px 20px",borderTop:"1px solid #F1F5F9",display:"flex",alignItems:"center",gap:8}}>
            <div style={{fontSize:11,color:"#94A3B8",flex:1}}>「✏️ 編集」で内容を修正、「🗑 削除」で削除できます</div>
            <button onClick={onClose}
              style={{padding:"10px 18px",background:"#1E3A5F",color:"white",border:"none",borderRadius:7,cursor:"pointer",fontSize:13,fontWeight:700}}>
              閉じる
            </button>
          </div>
        )}
        {tab==="pattern"&&(
          <div style={{padding:"12px 20px",borderTop:"1px solid #F1F5F9"}}>
            <button onClick={onClose}
              style={{width:"100%",padding:"10px",background:"#F1F5F9",color:"#64748B",border:"none",borderRadius:7,cursor:"pointer",fontSize:14,fontWeight:700}}>
              閉じる
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
function PeriodSwitcher({periodDefs,setPeriodDefs,activePeriodId,switchPeriod,addPeriod,deletePeriod}){
  const[open,setOpen]=React.useState(false);
  const[editing,setEditing]=React.useState(null); // period id being renamed
  const[editName,setEditName]=React.useState("");
  const[editStart,setEditStart]=React.useState("");
  const[editEnd,setEditEnd]=React.useState("");
  const ref=React.useRef(null);
  const activeDef=periodDefs.find(p=>p.id===activePeriodId)||periodDefs[0];

  React.useEffect(()=>{
    if(!open)return;
    const h=e=>{if(ref.current&&!ref.current.contains(e.target))setOpen(false);};
    document.addEventListener("mousedown",h);
    return()=>document.removeEventListener("mousedown",h);
  },[open]);

  const startEdit=(def)=>{
    setEditing(def.id);
    setEditName(def.name);
    setEditStart(def.startDate||"");
    setEditEnd(def.endDate||"");
  };

  const saveEdit=(id)=>{
    setPeriodDefs(prev=>prev.map(p=>p.id!==id?p:{...p,name:editName,startDate:editStart||null,endDate:editEnd||null}));
    setEditing(null);
  };

  return(
    <div ref={ref} style={{position:"relative",flexShrink:0,marginRight:4}}>
      <button onClick={()=>setOpen(o=>!o)}
        style={{padding:"4px 12px",border:"1.5px solid #E2E8F0",borderRadius:5,cursor:"pointer",fontSize:11,
          background:open?"#EFF6FF":"white",color:"#1E3A5F",fontWeight:700,
          display:"flex",alignItems:"center",gap:5,whiteSpace:"nowrap"}}>
        🗂 {activeDef?.name||"期間"}
        <span style={{fontSize:9,opacity:0.6}}>{open?"▲":"▼"}</span>
      </button>

      {open&&(
        <div style={{position:"fixed",top:"auto",zIndex:99999,background:"white",borderRadius:10,
          border:"1px solid #E2E8F0",minWidth:280,boxShadow:"0 8px 32px rgba(0,0,0,0.15)",overflow:"hidden"}}
          ref={el=>{
            if(el&&ref.current){
              const r=ref.current.getBoundingClientRect();
              el.style.top=(r.bottom+4)+"px";
              el.style.left=r.left+"px";
            }
          }}>
          <div style={{padding:"10px 14px 6px",borderBottom:"1px solid #F1F5F9",fontSize:11,fontWeight:700,color:"#94A3B8",letterSpacing:"0.05em"}}>
            基本時間割の期間
          </div>

          {periodDefs.map(def=>(
            <div key={def.id}>
              {editing===def.id?(
                <div style={{padding:"8px 12px",background:"#F0F9FF",borderBottom:"1px solid #E2E8F0"}}>
                  <input value={editName} onChange={e=>setEditName(e.target.value)}
                    placeholder="期間名"
                    style={{width:"100%",padding:"5px 8px",border:"1px solid #BAE6FD",borderRadius:5,fontSize:12,marginBottom:5,boxSizing:"border-box"}}/>
                  <div style={{display:"flex",gap:4,marginBottom:5}}>
                    <div style={{flex:1}}>
                      <div style={{fontSize:10,color:"#94A3B8",marginBottom:2}}>開始日</div>
                      <input type="date" value={editStart} onChange={e=>setEditStart(e.target.value)}
                        style={{width:"100%",padding:"4px 6px",border:"1px solid #BAE6FD",borderRadius:5,fontSize:11,boxSizing:"border-box"}}/>
                    </div>
                    <div style={{flex:1}}>
                      <div style={{fontSize:10,color:"#94A3B8",marginBottom:2}}>終了日</div>
                      <input type="date" value={editEnd} onChange={e=>setEditEnd(e.target.value)}
                        style={{width:"100%",padding:"4px 6px",border:"1px solid #BAE6FD",borderRadius:5,fontSize:11,boxSizing:"border-box"}}/>
                    </div>
                  </div>
                  <div style={{display:"flex",gap:4}}>
                    <button onClick={()=>saveEdit(def.id)}
                      style={{flex:1,padding:"5px",background:"#1E3A5F",color:"white",border:"none",borderRadius:5,cursor:"pointer",fontSize:12,fontWeight:700}}>
                      保存
                    </button>
                    <button onClick={()=>setEditing(null)}
                      style={{padding:"5px 10px",background:"#F1F5F9",color:"#64748B",border:"none",borderRadius:5,cursor:"pointer",fontSize:12}}>
                      取消
                    </button>
                  </div>
                </div>
              ):(
                <div
                  style={{display:"flex",alignItems:"center",gap:6,padding:"9px 12px",
                    background:activePeriodId===def.id?"#EFF6FF":"white",
                    borderBottom:"1px solid #F8FAFC",cursor:"pointer",
                    transition:"background 0.1s"}}
                  onMouseEnter={e=>{if(activePeriodId!==def.id)e.currentTarget.style.background="#F8FAFC";}}
                  onMouseLeave={e=>{if(activePeriodId!==def.id)e.currentTarget.style.background="white";}}>
                  <div style={{flex:1}} onClick={()=>{if(activePeriodId!==def.id){switchPeriod(def.id);setOpen(false);}}} >
                    <div style={{fontSize:12,fontWeight:activePeriodId===def.id?700:400,color:activePeriodId===def.id?"#1D4ED8":"#1E293B",display:"flex",alignItems:"center",gap:4}}>
                      {activePeriodId===def.id&&<span style={{fontSize:9}}>✓</span>}
                      {def.name}
                    </div>
                    {(def.startDate||def.endDate)&&(
                      <div style={{fontSize:10,color:"#94A3B8",marginTop:1}}>
                        {def.startDate||"…"} 〜 {def.endDate||"…"}
                      </div>
                    )}
                  </div>
                  <button onClick={e=>{e.stopPropagation();startEdit(def);}}
                    style={{padding:"2px 6px",background:"#F1F5F9",border:"none",borderRadius:4,cursor:"pointer",fontSize:10,color:"#64748B"}}>
                    ✏
                  </button>
                  {periodDefs.length>1&&(
                    <button onClick={e=>{e.stopPropagation();deletePeriod(def.id);}}
                      style={{padding:"2px 6px",background:"#FEE2E2",border:"none",borderRadius:4,cursor:"pointer",fontSize:10,color:"#DC2626"}}>
                      🗑
                    </button>
                  )}
                </div>
              )}
            </div>
          ))}

          <div style={{padding:"8px 12px",borderTop:"1px solid #F1F5F9"}}>
            <button onClick={()=>{addPeriod();setOpen(false);}}
              style={{width:"100%",padding:"7px",background:"#F0F9FF",border:"1.5px dashed #93C5FD",borderRadius:6,
                cursor:"pointer",fontSize:12,color:"#1D4ED8",fontWeight:700}}>
              ＋ 新しい期間を追加
            </button>
            <div style={{fontSize:10,color:"#94A3B8",marginTop:5,textAlign:"center"}}>
              期間を切り替えると、基本時間割・先生の持ち時間がそれぞれ保存されます
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── MeetingModal ──────────────────────────────────────────────────────────────
function MeetingModal({meetings,setMeetings,teachers,onClose}){
  const DAYS7=["月","火","水","木","金","土","日"];
  const PERIODS=[1,2,3,4,5,6];
  const MTG_TYPES=["学年部会","校務運営委員会","教科部会","その他"];
  const TYPE_COLORS=MTG_TYPE_COLORS;

  const blank=()=>({id:Date.now()+Math.random()*1e6|0,name:"",type:"学年部会",day:"月",period:1,teacherIds:[]});
  const[editing,setEditing]=React.useState(null); // meeting being edited
  const[form,setForm]=React.useState(blank());

  const scrollRef=React.useRef(null);
  const startNew=()=>{const b=blank();setForm(b);setEditing("new");setTimeout(()=>scrollRef.current?.scrollTo({top:0,behavior:"smooth"}),50);};
  const startEdit=(m)=>{setForm({...m,teacherIds:[...m.teacherIds]});setEditing(m.id);setTimeout(()=>scrollRef.current?.scrollTo({top:0,behavior:"smooth"}),50);};
  const cancelEdit=()=>{setEditing(null);};

  const save=()=>{
    if(!form.name.trim()){alert("会議名を入力してください");return;}
    if(form.teacherIds.length===0){alert("参加教員を1名以上選択してください");return;}
    if(editing==="new"){
      setMeetings(prev=>[...prev,{...form,id:Date.now()}]);
    }else{
      setMeetings(prev=>prev.map(m=>m.id===editing?{...form}:m));
    }
    setEditing(null);
  };

  const deleteMtg=(id)=>{
    if(!window.confirm("この会議を削除しますか？"))return;
    setMeetings(prev=>prev.filter(m=>m.id!==id));
  };

  const toggleTid=(tid)=>{
    setForm(f=>{
      const s=new Set(f.teacherIds);
      s.has(tid)?s.delete(tid):s.add(tid);
      return{...f,teacherIds:[...s]};
    });
  };

  // 曜日・時限でグループ化して表示
  const grouped=React.useMemo(()=>{
    const map={};
    meetings.forEach(m=>{
      const k=`${m.day}|${m.period}`;
      if(!map[k])map[k]=[];
      map[k].push(m);
    });
    return map;
  },[meetings]);

  const INP={padding:"6px 10px",border:"1.5px solid #E2E8F0",borderRadius:6,fontSize:12,
    boxSizing:"border-box",outline:"none",fontFamily:"inherit",width:"100%"};

  return(
    <div style={{position:"fixed",inset:0,background:"rgba(15,23,42,0.65)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:500}} onClick={onClose}>
      <div style={{background:"white",borderRadius:12,width:680,maxWidth:"96vw",maxHeight:"94vh",display:"flex",flexDirection:"column",boxShadow:"0 20px 60px rgba(0,0,0,0.3)"}} onClick={e=>e.stopPropagation()}>

        {/* ヘッダー */}
        <div style={{padding:"16px 20px 12px",borderBottom:"1px solid #F1F5F9",display:"flex",alignItems:"center",gap:12}}>
          <div style={{flex:1}}>
            <div style={{fontWeight:700,fontSize:16,color:"#1E3A5F"}}>📋 会議管理</div>
            <div style={{fontSize:11,color:"#94A3B8",marginTop:2}}>
              教科部会・学年部会などを登録すると、教員ビューに表示され授業との重複を検出します
            </div>
          </div>
          <button onClick={startNew}
            style={{padding:"8px 16px",background:"#6D28D9",color:"white",border:"none",
              borderRadius:7,cursor:"pointer",fontSize:13,fontWeight:700,flexShrink:0,whiteSpace:"nowrap"}}>
            ＋ 会議を追加
          </button>
        </div>

        <div ref={scrollRef} style={{overflowY:"auto",flex:1,padding:"14px 20px",display:"flex",flexDirection:"column",gap:14}}>

          {/* 編集フォーム */}
          {editing&&(
            <div style={{background:"#F5F3FF",border:"2px solid #8B5CF6",borderRadius:10,padding:"16px"}}>
              <div style={{fontWeight:700,fontSize:13,color:"#6D28D9",marginBottom:12}}>
                {editing==="new"?"新しい会議を追加":"会議を編集"}
              </div>

              <div style={{display:"flex",gap:10,marginBottom:10,flexWrap:"wrap"}}>
                {/* 種別 */}
                <div style={{flex:"0 0 auto"}}>
                  <div style={{fontSize:10,color:"#6B7280",marginBottom:4}}>種別</div>
                  <div style={{display:"flex",gap:4,flexWrap:"wrap"}}>
                    {MTG_TYPES.map(t=>{
                      const on=form.type===t;
                      return(
                        <button key={t} onClick={()=>setForm(f=>({...f,type:t}))}
                          style={{padding:"3px 10px",border:`1.5px solid ${on?TYPE_COLORS[t]||"#475569":"#CBD5E1"}`,
                            borderRadius:5,cursor:"pointer",fontSize:11,fontWeight:on?700:400,
                            background:on?TYPE_COLORS[t]||"#475569":"white",
                            color:on?"white":"#374151"}}>
                          {t}
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>

              <div style={{display:"flex",gap:10,marginBottom:10,flexWrap:"wrap"}}>
                {/* 会議名 */}
                <div style={{flex:2,minWidth:160}}>
                  <div style={{fontSize:10,color:"#6B7280",marginBottom:4}}>会議名</div>
                  <input value={form.name} onChange={e=>setForm(f=>({...f,name:e.target.value}))}
                    placeholder="例：3学年部会、数学教科部会"
                    style={INP}/>
                </div>
                {/* 曜日 */}
                <div style={{flex:"0 0 auto"}}>
                  <div style={{fontSize:10,color:"#6B7280",marginBottom:4}}>曜日</div>
                  <select value={form.day} onChange={e=>setForm(f=>({...f,day:e.target.value}))}
                    style={{...INP,width:"auto",paddingRight:24}}>
                    {DAYS7.map(d=><option key={d} value={d}>{d}曜</option>)}
                  </select>
                </div>
                {/* 時限 */}
                <div style={{flex:"0 0 auto"}}>
                  <div style={{fontSize:10,color:"#6B7280",marginBottom:4}}>時限</div>
                  <select value={form.period} onChange={e=>setForm(f=>({...f,period:Number(e.target.value)}))}
                    style={{...INP,width:"auto",paddingRight:24}}>
                    {PERIODS.map(p=><option key={p} value={p}>{p}限</option>)}
                  </select>
                </div>
              </div>

              {/* 参加教員 */}
              <div style={{marginBottom:12}}>
                <div style={{fontSize:10,color:"#6B7280",marginBottom:5}}>
                  参加教員 <span style={{color:"#8B5CF6",fontWeight:700}}>（{form.teacherIds.length}名選択）</span>
                </div>
                <div style={{display:"flex",gap:4,flexWrap:"wrap",maxHeight:120,overflowY:"auto",
                  padding:"6px 8px",background:"white",borderRadius:7,border:"1px solid #E2E8F0"}}>
                  {teachers.map(t=>{
                    const on=form.teacherIds.includes(t.id);
                    return(
                      <button key={t.id} onClick={()=>toggleTid(t.id)}
                        style={{padding:"3px 10px",border:`1.5px solid ${on?"#6D28D9":"#CBD5E1"}`,
                          borderRadius:5,cursor:"pointer",fontSize:11,fontWeight:on?700:400,
                          background:on?"#6D28D9":"white",color:on?"white":"#374151"}}>
                        {t.name}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div style={{display:"flex",gap:8}}>
                <button onClick={save}
                  style={{padding:"8px 20px",background:"#6D28D9",color:"white",border:"none",
                    borderRadius:6,cursor:"pointer",fontSize:13,fontWeight:700}}>
                  ✓ 保存
                </button>
                <button onClick={cancelEdit}
                  style={{padding:"8px 16px",background:"#F1F5F9",color:"#64748B",border:"none",
                    borderRadius:6,cursor:"pointer",fontSize:13}}>
                  取消
                </button>
              </div>
            </div>
          )}

          {/* 登録済み会議一覧 */}
          {meetings.length===0&&!editing?(
            <div style={{textAlign:"center",color:"#CBD5E1",padding:"32px 0",fontSize:14}}>
              会議が登録されていません。「＋ 会議を追加」から登録してください。
            </div>
          ):(
            DAYS7.filter(d=>meetings.some(m=>m.day===d)).map(d=>(
              <div key={d}>
                <div style={{fontSize:11,fontWeight:700,color:"#94A3B8",marginBottom:6,
                  display:"flex",alignItems:"center",gap:6}}>
                  <span style={{background:"#F1F5F9",padding:"1px 8px",borderRadius:4}}>{d}曜日</span>
                </div>
                {PERIODS.filter(p=>meetings.some(m=>m.day===d&&m.period===p)).map(p=>(
                  <div key={p} style={{marginBottom:8}}>
                    <div style={{fontSize:10,color:"#CBD5E1",marginBottom:3,marginLeft:4}}>
                      {p}限
                    </div>
                    {(grouped[`${d}|${p}`]||[]).map(m=>{
                      const c=TYPE_COLORS[m.type]||"#475569";
                      return(
                        <div key={m.id} style={{display:"flex",alignItems:"center",gap:10,
                          padding:"10px 14px",background:"white",border:`1.5px solid ${c}22`,
                          borderLeft:`4px solid ${c}`,borderRadius:8,marginBottom:6}}>
                          <div style={{flex:1,minWidth:0}}>
                            <div style={{display:"flex",alignItems:"center",gap:6,flexWrap:"wrap",marginBottom:3}}>
                              <span style={{background:c,color:"white",borderRadius:4,
                                padding:"1px 7px",fontSize:10,fontWeight:700,flexShrink:0}}>
                                {m.type}
                              </span>
                              <span style={{fontWeight:700,fontSize:14,color:"#1E293B"}}>
                                {m.name}
                              </span>
                            </div>
                            <div style={{fontSize:11,color:"#64748B",display:"flex",gap:4,flexWrap:"wrap"}}>
                              {(m.teacherIds||[]).map(tid=>{
                                const t=teachers.find(x=>x.id===tid);
                                return t?(
                                  <span key={tid} style={{background:"#F1F5F9",borderRadius:3,padding:"1px 6px"}}>
                                    {t.name}
                                  </span>
                                ):null;
                              })}
                            </div>
                          </div>
                          <div style={{display:"flex",gap:6,flexShrink:0}}>
                            <button onClick={()=>startEdit(m)}
                              style={{padding:"4px 10px",background:"#F1F5F9",color:"#374151",
                                border:"none",borderRadius:5,cursor:"pointer",fontSize:12}}>
                              ✏ 編集
                            </button>
                            <button onClick={()=>deleteMtg(m.id)}
                              style={{padding:"4px 10px",background:"#FEE2E2",color:"#DC2626",
                                border:"none",borderRadius:5,cursor:"pointer",fontSize:12}}>
                              🗑
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ))}
              </div>
            ))
          )}
        </div>

        {/* フッター */}
        <div style={{padding:"12px 20px",borderTop:"1px solid #F1F5F9",display:"flex",alignItems:"center",gap:8}}>
          <div style={{fontSize:11,color:"#94A3B8",flex:1}}>
            会議は教員ビューのセルに 📋 で表示されます。授業と重複する場合は ⚠ で警告します。
          </div>
          <button onClick={onClose}
            style={{padding:"9px 20px",background:"#1E3A5F",color:"white",border:"none",
              borderRadius:7,cursor:"pointer",fontSize:13,fontWeight:700}}>
            閉じる
          </button>
        </div>
      </div>
    </div>
  );
}

// ── ChainSwapModal ────────────────────────────────────────────────────────────
// ── 玉突き提案モーダル ──────────────────────────────────────────────────────
// 移動元の空き枠を、同一クラスの授業をずらして埋める連鎖（1〜3手）を提案する
function FillHoleModal({modal,classes,teachers,onExec,onClose}){
  const{srcEntry,srcDc,tgtDc,chains}=modal;
  // モーダルをたたんで後ろの時間割を確認するモード
  const[minimized,setMinimized]=React.useState(false);
  const cn=id=>classes.find(c=>c.id===id)?.name||id;
  const tn=id=>teachers.find(t=>t.id===id)?.name||id;
  const slotL=s=>`${s.day}曜${s.period}限`;
  const clsLabel=(srcEntry.classIds||[]).map(cn).join("・");
  // 手数ごとにグループ化（表示上限：1手8件・2手6件・3手6件）
  const byDepth=[[],[],[]];
  chains.forEach(c=>{const d=c.steps.length;if(d>=1&&d<=3)byDepth[d-1].push(c);});
  const caps=[8,6,6];
  const depthLabels=["あと1手で埋める","あと2手で埋める","あと3手で埋める"];

  const StepChip=({step,idx})=>(
    <div style={{display:"flex",alignItems:"center",gap:6}}>
      <span style={{flexShrink:0,width:18,height:18,borderRadius:"50%",background:step.kind==='displace'?"#B45309":"#1E3A5F",color:"white",
        fontSize:10,fontWeight:700,display:"flex",alignItems:"center",justifyContent:"center"}}>{idx+1}</span>
      {step.kind==='displace'&&(
        <span style={{flexShrink:0,fontSize:9,fontWeight:700,color:"#B45309",background:"#FEF3C7",
          borderRadius:4,padding:"1px 5px"}}>どかす</span>
      )}
      <span style={{fontSize:12,color:"#1E293B"}}>
        <b>{step.entry.subject}</b>
        <span style={{color:"#64748B",fontSize:11}}>（{(step.entry.classIds||[]).map(cn).join("・")}・{(step.entry.teacherIds||[]).map(tn).join("・")}先生）</span>
        　{slotL(step.from)}
        <span style={{color:"#94A3B8",margin:"0 4px"}}>→</span>
        <b style={{color:step.kind==='displace'?"#B45309":"#065F46"}}>{slotL(step.to)}</b>
      </span>
    </div>
  );

  if(minimized){
    return(
      <button onClick={()=>setMinimized(false)}
        style={{
          position:'fixed',top:'50%',right:0,transform:'translateY(-50%)',
          zIndex:500,
          background:'#1E3A5F',color:'white',border:'none',
          borderRadius:'10px 0 0 10px',padding:'14px 10px',
          cursor:'pointer',fontSize:12,fontWeight:700,
          writingMode:'vertical-rl',letterSpacing:2,
          boxShadow:'-4px 0 16px rgba(0,0,0,0.25)',
        }}>
        ◀ 🧩 玉突き候補を再表示
      </button>
    );
  }

  return(
    <div style={{position:"fixed",inset:0,background:"rgba(15,23,42,0.65)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:500}} onClick={onClose}>
      <div style={{background:"white",borderRadius:12,width:560,maxWidth:"95vw",maxHeight:"90vh",overflowY:"auto",
        boxShadow:"0 20px 60px rgba(0,0,0,0.3)"}} onClick={e=>e.stopPropagation()}>

        {/* ヘッダー */}
        <div style={{padding:"16px 20px 12px",borderBottom:"1px solid #F1F5F9",position:"sticky",top:0,background:"white",zIndex:1}}>
          <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",gap:8}}>
            <div style={{fontWeight:700,fontSize:16,color:"#1E3A5F"}}>🧩 空いた枠を玉突きで埋めますか？</div>
            <button onClick={()=>setMinimized(true)}
              title="モーダルをたたんで時間割を確認"
              style={{flexShrink:0,background:'#F1F5F9',border:'1px solid #E2E8F0',cursor:'pointer',
                color:'#475569',fontSize:11,fontWeight:700,borderRadius:6,
                padding:'5px 10px',whiteSpace:'nowrap'}}>
              👁 時間割を見る
            </button>
          </div>
          <div style={{fontSize:11,color:"#64748B",marginTop:4,lineHeight:1.6}}>
            {srcEntry.subject}を{slotL(tgtDc)}へ移動したため、<b style={{color:"#B45309"}}>{slotL(srcDc)}（{clsLabel}）</b>が空きました。<br/>
            同じクラスの授業をずらして埋める候補です。先生の空き時間・会議・不在は確認済みです。<br/>
            先生が重なる場合は、相手クラスの授業を空き枠へ<b style={{color:"#B45309"}}>どかす</b>案も含みます。
          </div>
        </div>

        <div style={{padding:"14px 20px",display:"flex",flexDirection:"column",gap:14}}>
          {byDepth.map((list,di)=>list.length===0?null:(
            <div key={di}>
              <div style={{fontSize:11,fontWeight:700,color:"#374151",marginBottom:8}}>
                {depthLabels[di]}（{list.length>caps[di]?`${caps[di]}件表示／全${list.length}件`:`${list.length}件`}）
              </div>
              <div style={{display:"flex",flexDirection:"column",gap:8}}>
                {list.slice(0,caps[di]).map((chain,ci)=>(
                  <div key={ci} style={{border:"2px solid #E2E8F0",borderRadius:10,padding:"10px 14px"}}>
                    <div style={{display:"flex",flexDirection:"column",gap:5,marginBottom:8}}>
                      {chain.steps.map((st,si)=><StepChip key={si} step={st} idx={si}/>)}
                    </div>
                    <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",gap:8}}>
                      <div style={{fontSize:11,color:"#B45309"}}>
                        ⇒ 最後に <b>{slotL(chain.finalHole)}（{(chain.finalHole.cids||[]).map(cn).join("・")}）</b> が空きます
                        {chain.steps.filter(s=>s.kind==='displace').map((s,i)=>(
                          <span key={i}><br/>※ {(s.entry.classIds||[]).map(cn).join("・")}は {slotL(s.from)} が空きになります</span>
                        ))}
                      </div>
                      <button onClick={()=>onExec(chain)}
                        style={{flexShrink:0,padding:"7px 18px",background:"#065F46",color:"white",border:"none",
                          borderRadius:7,cursor:"pointer",fontSize:12,fontWeight:700}}>
                        この手順で実行
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>

        {/* フッター */}
        <div style={{padding:"10px 20px 16px",display:"flex",justifyContent:"center",borderTop:"1px solid #F1F5F9"}}>
          <button onClick={onClose}
            style={{padding:"8px 28px",background:"#F1F5F9",color:"#475569",border:"none",
              borderRadius:7,cursor:"pointer",fontSize:12,fontWeight:700}}>
            このまま（埋めない）
          </button>
        </div>
      </div>
    </div>
  );
}

function ChainSwapModal({chainModal,base,dateMode,classes,teachers,executeChainSwap,onClose}){
  const{srcEntry,srcDc,tgtEntry,tgtDc,candidates,execDirect}=chainModal;
  const cn=id=>classes.find(c=>c.id===id)?.name||id;
  const tn=id=>teachers.find(t=>t.id===id)?.name||id;
  const DAYS7=["月","火","水","木","金","土","日"];

  const slotLabel=(e,dc)=>{
    if(dateMode&&dc?.date){
      const d=new Date(dc.date+"T00:00:00");
      return`${d.getMonth()+1}/${d.getDate()}（${DAYS7[d.getDay()]}）${dc.period}限`;
    }
    if(e?.day)return`${e.day}曜${e.period}限`;
    return`${dc?.day||"?"}曜${dc?.period||"?"}限`;
  };

  // baseから対象エントリのdcを復元
  const getDc=(entry)=>{
    if(!entry)return null;
    return{day:entry.day,period:entry.period,date:entry.date||null,matchCid:null,matchTid:null};
  };

  const Arrow=()=><span style={{color:"#94A3B8",margin:"0 6px",fontSize:16}}>→</span>;

  const EntryChip=({entry,slotLabel,color="#1E3A5F"})=>(
    <div style={{display:"flex",flexDirection:"column",alignItems:"center",
      background:color+"15",border:`1.5px solid ${color}44`,
      borderRadius:8,padding:"8px 14px",minWidth:130}}>
      <div style={{fontSize:10,color:"#94A3B8",marginBottom:2}}>{slotLabel}</div>
      <div style={{fontWeight:700,fontSize:13,color:"#1E293B"}}>{entry.subject}</div>
      <div style={{fontSize:10,color:"#64748B"}}>{(entry.classIds||[]).map(c=>cn(c)).join("・")}</div>
      <div style={{fontSize:10,color:"#64748B"}}>{(entry.teacherIds||[]).map(t=>tn(t)).join("・")}先生</div>
    </div>
  );

  return(
    <div style={{position:"fixed",inset:0,background:"rgba(15,23,42,0.65)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:500}} onClick={onClose}>
      <div style={{background:"white",borderRadius:12,width:560,maxWidth:"95vw",maxHeight:"90vh",overflowY:"auto",
        boxShadow:"0 20px 60px rgba(0,0,0,0.3)"}} onClick={e=>e.stopPropagation()}>

        {/* ヘッダー */}
        <div style={{padding:"16px 20px 12px",borderBottom:"1px solid #F1F5F9"}}>
          <div style={{fontWeight:700,fontSize:16,color:"#1E3A5F"}}>🔄 交換の方法を選んでください</div>
          <div style={{fontSize:11,color:"#94A3B8",marginTop:3}}>
            ドロップ先に授業があります。直接交換するか、3コマ回転を選んでください。
          </div>
        </div>

        <div style={{padding:"16px 20px",display:"flex",flexDirection:"column",gap:12}}>

          {/* 直接交換 */}
          <div style={{border:"2px solid #E2E8F0",borderRadius:10,padding:"14px 16px"}}>
            <div style={{fontSize:11,fontWeight:700,color:"#374151",marginBottom:10}}>⇄ 直接交換</div>
            <div style={{display:"flex",alignItems:"center",justifyContent:"center",flexWrap:"wrap",gap:4}}>
              <EntryChip entry={srcEntry} slotLabel={slotLabel(srcEntry,srcDc)} color="#1D4ED8"/>
              <Arrow/>
              <EntryChip entry={tgtEntry} slotLabel={slotLabel(tgtEntry,tgtDc)} color="#7C3AED"/>
            </div>
            <div style={{display:"flex",justifyContent:"center",marginTop:12}}>
              <button onClick={()=>{execDirect();onClose();}}
                style={{padding:"9px 28px",background:"#1E3A5F",color:"white",border:"none",
                  borderRadius:7,cursor:"pointer",fontSize:13,fontWeight:700}}>
                ⇄ 直接交換で実行
              </button>
            </div>
          </div>

          {/* 3コマ回転候補 */}
          {candidates.length>0&&(
            <div>
              <div style={{fontSize:11,fontWeight:700,color:"#374151",marginBottom:8}}>
                🔄 3コマ回転の候補（{candidates.length}件）
              </div>
              <div style={{display:"flex",flexDirection:"column",gap:8}}>
                {candidates.map((cEntry,i)=>{
                  const cDc=getDc(cEntry);
                  return(
                    <div key={cEntry.id} style={{border:"2px solid #E2E8F0",borderRadius:10,padding:"12px 14px",
                      transition:"border-color 0.1s"}}>
                      {/* 回転図 */}
                      <div style={{display:"flex",alignItems:"center",justifyContent:"center",flexWrap:"wrap",gap:4,marginBottom:10}}>
                        <EntryChip entry={srcEntry} slotLabel={slotLabel(srcEntry,srcDc)} color="#1D4ED8"/>
                        <div style={{display:"flex",flexDirection:"column",alignItems:"center"}}>
                          <Arrow/>
                          <div style={{fontSize:9,color:"#94A3B8",marginTop:-4}}>{slotLabel(tgtEntry,tgtDc)}</div>
                        </div>
                        <EntryChip entry={tgtEntry} slotLabel={slotLabel(tgtEntry,tgtDc)} color="#7C3AED"/>
                        <div style={{display:"flex",flexDirection:"column",alignItems:"center"}}>
                          <Arrow/>
                          <div style={{fontSize:9,color:"#94A3B8",marginTop:-4}}>{slotLabel(cEntry,cDc)}</div>
                        </div>
                        <EntryChip entry={cEntry} slotLabel={slotLabel(cEntry,cDc)} color="#065F46"/>
                        <div style={{display:"flex",flexDirection:"column",alignItems:"center"}}>
                          <Arrow/>
                          <div style={{fontSize:9,color:"#94A3B8",marginTop:-4}}>{slotLabel(srcEntry,srcDc)}</div>
                        </div>
                      </div>
                      {/* 説明テキスト */}
                      <div style={{fontSize:11,color:"#475569",textAlign:"center",marginBottom:8}}>
                        {srcEntry.subject}({slotLabel(srcEntry,srcDc)})
                        → {tgtEntry.subject}の位置({slotLabel(tgtEntry,tgtDc)})へ、
                        {tgtEntry.subject}→ {cEntry.subject}の位置({slotLabel(cEntry,cDc)})へ、
                        {cEntry.subject}→ {srcEntry.subject}の位置({slotLabel(srcEntry,srcDc)})へ
                      </div>
                      <div style={{display:"flex",justifyContent:"center"}}>
                        <button onClick={()=>executeChainSwap(srcEntry,srcDc,tgtEntry,tgtDc,cEntry,cDc)}
                          style={{padding:"8px 24px",background:"#065F46",color:"white",border:"none",
                            borderRadius:7,cursor:"pointer",fontSize:13,fontWeight:700}}>
                          🔄 この3コマ回転で実行
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        {/* フッター */}
        <div style={{padding:"12px 20px",borderTop:"1px solid #F1F5F9",display:"flex",justifyContent:"flex-end"}}>
          <button onClick={onClose}
            style={{padding:"9px 20px",background:"#F1F5F9",color:"#64748B",border:"none",
              borderRadius:7,cursor:"pointer",fontSize:13,fontWeight:700}}>
            キャンセル
          </button>
        </div>
      </div>
    </div>
  );
}

// ── 🔍 IntegrityModal ─────────────────────────────────────────────────────────
function IntegrityModal({base,setBase,changes,setChanges,teachers,setTeachers,classes,saveRef,setSaving,onClose}){
  const cn=id=>(classes||[]).find(c=>c.id===id)?.name||id;
  const tn=id=>(teachers||[]).find(t=>t.id===id)?.name||id;
  const validTids=new Set((teachers||[]).map(t=>t.id));
  const validCids=new Set((classes||[]).map(c=>c.id));

  // 使用状況
  const usedTids=new Set();
  const usedCids=new Set();
  [...(base||[]),...(changes||[])].forEach(e=>{
    (e.teacherIds||[]).forEach(t=>usedTids.add(t));
    (e.classIds||[]).forEach(c=>usedCids.add(c));
  });

  // ゴースト集計
  const ghostTeacherIds=new Set();
  const ghostClassIds=new Set();
  const baseGhost=[];
  const chgGhost=[];
  (base||[]).forEach(e=>{
    let g=false;
    (e.teacherIds||[]).forEach(t=>{if(!validTids.has(t)){ghostTeacherIds.add(t);g=true;}});
    (e.classIds||[]).forEach(c=>{if(!validCids.has(c)){ghostClassIds.add(c);g=true;}});
    if(g)baseGhost.push(e);
  });
  (changes||[]).forEach(e=>{
    let g=false;
    (e.teacherIds||[]).forEach(t=>{if(!validTids.has(t)){ghostTeacherIds.add(t);g=true;}});
    (e.classIds||[]).forEach(c=>{if(!validCids.has(c)){ghostClassIds.add(c);g=true;}});
    if(g)chgGhost.push(e);
  });
  const ghostT=[...ghostTeacherIds];
  const ghostC=[...ghostClassIds];

  const unusedTeachers=(teachers||[]).filter(t=>!usedTids.has(t.id));
  const unusedClasses=(classes||[]).filter(c=>!usedCids.has(c.id));

  const removeOneTeacher=async(tid,name)=>{
    if(!window.confirm(`先生「${name}」(${tid}) を teachers から削除しますか？\n（base/changes 内のこの先生のIDも除去されます）`))return;
    setSaving(true);
    try{await sbSaveBackup(saveRef.current,`先生削除前バックアップ:${name}`);}catch(e){}
    setSaving(false);
    setTeachers(p=>p.filter(t=>t.id!==tid));
    setBase(p=>p.map(e=>({...e,teacherIds:(e.teacherIds||[]).filter(t=>t!==tid)})).filter(e=>(e.classIds||[]).length>0));
    setChanges(p=>p.map(e=>({...e,teacherIds:(e.teacherIds||[]).filter(t=>t!==tid)})).filter(e=>(e.classIds||[]).length>0||e._removed));
  };

  const cleanGhosts=async()=>{
    if(!window.confirm(`ゴーストID（先生${ghostT.length}件、クラス${ghostC.length}件）を base/changes から除去します。よろしいですか？`))return;
    setSaving(true);
    try{await sbSaveBackup(saveRef.current,'ゴーストID除去前バックアップ');}catch(e){}
    setSaving(false);
    setBase(p=>p.map(e=>({
      ...e,
      teacherIds:(e.teacherIds||[]).filter(t=>validTids.has(t)),
      classIds:(e.classIds||[]).filter(c=>validCids.has(c)),
    })).filter(e=>(e.classIds||[]).length>0));
    setChanges(p=>p.map(e=>({
      ...e,
      teacherIds:(e.teacherIds||[]).filter(t=>validTids.has(t)),
      classIds:(e.classIds||[]).filter(c=>validCids.has(c)),
    })).filter(e=>(e.classIds||[]).length>0||e._removed));
    alert('✅ ゴーストID除去完了');
  };

  const removeUnusedTeachers=async()=>{
    if(unusedTeachers.length===0)return;
    if(!window.confirm(`未使用の先生 ${unusedTeachers.length}名（${unusedTeachers.map(t=>t.name).join('、')}）を一括削除します。よろしいですか？`))return;
    setSaving(true);
    try{await sbSaveBackup(saveRef.current,'未使用先生一括削除前バックアップ');}catch(e){}
    setSaving(false);
    const unusedIds=new Set(unusedTeachers.map(t=>t.id));
    setTeachers(p=>p.filter(t=>!unusedIds.has(t.id)));
    alert(`✅ ${unusedTeachers.length}名を削除しました`);
  };

  return(
    <div onClick={onClose} style={{position:'fixed',inset:0,background:'rgba(0,0,0,0.5)',display:'flex',alignItems:'center',justifyContent:'center',zIndex:9999}}>
      <div onClick={e=>e.stopPropagation()} style={{background:'white',borderRadius:8,padding:24,width:'min(720px,92vw)',maxHeight:'88vh',overflowY:'auto',boxShadow:'0 10px 40px rgba(0,0,0,0.3)'}}>
        <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:16}}>
          <h2 style={{margin:0,fontSize:18,fontWeight:700,color:'#0F172A'}}>🔍 データ整合性チェック</h2>
          <button onClick={onClose} style={{background:'#F1F5F9',border:'none',borderRadius:4,padding:'4px 12px',cursor:'pointer',fontSize:14}}>✕</button>
        </div>

        {/* 先生リスト */}
        <div style={{marginBottom:16,padding:12,background:'#F8FAFC',borderRadius:6}}>
          <div style={{fontSize:13,fontWeight:700,marginBottom:8,color:'#0F172A'}}>
            ■ 先生リスト（teachers state） 全{(teachers||[]).length}名
            {unusedTeachers.length>0&&<button onClick={removeUnusedTeachers} style={{marginLeft:12,background:'#DC2626',color:'white',border:'none',borderRadius:4,padding:'4px 10px',fontSize:11,cursor:'pointer'}}>未使用{unusedTeachers.length}名を一括削除</button>}
          </div>
          <div style={{maxHeight:200,overflowY:'auto',fontSize:12}}>
            {(teachers||[]).map(t=>{
              const used=usedTids.has(t.id);
              return(
                <div key={t.id} style={{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'4px 8px',borderBottom:'1px solid #E2E8F0',background:used?'transparent':'#FEF3C7'}}>
                  <span><code style={{color:'#64748B'}}>{t.id}</code> <strong>{t.name}</strong> <span style={{color:used?'#059669':'#B45309',fontSize:11}}>{used?'✓使用中':'✗未使用'}</span></span>
                  <button onClick={()=>removeOneTeacher(t.id,t.name)} style={{background:'#EF4444',color:'white',border:'none',borderRadius:4,padding:'2px 8px',fontSize:11,cursor:'pointer'}}>削除</button>
                </div>
              );
            })}
          </div>
        </div>

        {/* クラスリスト */}
        <div style={{marginBottom:16,padding:12,background:'#F8FAFC',borderRadius:6}}>
          <div style={{fontSize:13,fontWeight:700,marginBottom:8,color:'#0F172A'}}>
            ■ クラスリスト（classes state） 全{(classes||[]).length}件
          </div>
          <div style={{maxHeight:140,overflowY:'auto',fontSize:12}}>
            {(classes||[]).map(c=>{
              const used=usedCids.has(c.id);
              return(
                <div key={c.id} style={{padding:'3px 8px',borderBottom:'1px solid #E2E8F0',background:used?'transparent':'#FEF3C7'}}>
                  <code style={{color:'#64748B'}}>{c.id}</code> <strong>{c.name}</strong> <span style={{color:used?'#059669':'#B45309',fontSize:11}}>{used?'✓使用中':'✗未使用'}</span>
                </div>
              );
            })}
          </div>
        </div>

        {/* ゴースト */}
        <div style={{marginBottom:16,padding:12,background:ghostT.length+ghostC.length>0?'#FEF2F2':'#F0FDF4',borderRadius:6}}>
          <div style={{fontSize:13,fontWeight:700,marginBottom:8,color:'#0F172A'}}>
            ■ ゴースト（teachers/classes に無いID）
            {(ghostT.length+ghostC.length)>0&&<button onClick={cleanGhosts} style={{marginLeft:12,background:'#DC2626',color:'white',border:'none',borderRadius:4,padding:'4px 10px',fontSize:11,cursor:'pointer'}}>ゴーストID除去</button>}
          </div>
          <div style={{fontSize:12}}>
            <div>先生ID: <strong>{ghostT.length}件</strong> {ghostT.length>0&&<code style={{color:'#DC2626'}}>[{ghostT.join(', ')}]</code>}</div>
            <div>クラスID: <strong>{ghostC.length}件</strong> {ghostC.length>0&&<code style={{color:'#DC2626'}}>[{ghostC.join(', ')}]</code>}</div>
            <div>base内の影響エントリ: <strong>{baseGhost.length}件</strong></div>
            <div>changes内の影響エントリ: <strong>{chgGhost.length}件</strong></div>
            {ghostT.length===0&&ghostC.length===0&&<div style={{color:'#059669',marginTop:4}}>✅ ゴーストなし</div>}
          </div>
        </div>

        <div style={{marginTop:16,padding:8,background:'#EFF6FF',borderRadius:6,fontSize:11,color:'#1E40AF'}}>
          💡 警告ダイアログに表示される先生IDが、上のリストに無ければ「ゴーストID除去」で修復できます。<br/>
          ⚠ 削除前に自動でバックアップを保存します。
        </div>

        {/* base の重複エントリ検出 */}
        {(()=>{
          const slotMap={};
          (base||[]).forEach(e=>{
            const k=`${e.day}-${e.period}-${(e.classIds||[]).sort().join(',')}`;
            if(!slotMap[k])slotMap[k]=[];
            slotMap[k].push(e);
          });
          const dups=Object.entries(slotMap).filter(([,arr])=>arr.length>1);
          if(dups.length===0)return null;
          return(
            <div style={{marginTop:12,padding:'10px 14px',background:'#FEF2F2',borderRadius:6,border:'1px solid #FECACA'}}>
              <div style={{fontSize:12,fontWeight:700,color:'#DC2626',marginBottom:8}}>
                ⚠️ base に重複エントリ {dups.length}件
                <button onClick={async()=>{
                  setSaving(true);
                  try{await sbSaveBackup(saveRef.current,'重複エントリ削除前バックアップ');}catch(e){}
                  setSaving(false);
                  // 各スロットで最後の1件だけ残す
                  const toRemove=new Set();
                  dups.forEach(([,arr])=>{
                    arr.slice(0,-1).forEach(e=>toRemove.add(e.id));
                  });
                  setBase(p=>p.filter(e=>!toRemove.has(e.id)));
                  alert(`✅ ${toRemove.size}件の重複エントリを削除しました`);
                }} style={{marginLeft:10,background:'#DC2626',color:'white',border:'none',borderRadius:4,padding:'3px 10px',fontSize:11,cursor:'pointer'}}>
                  重複を削除
                </button>
              </div>
              <div style={{fontSize:11,color:'#374151',maxHeight:120,overflowY:'auto'}}>
                {dups.map(([k,arr])=>(
                  <div key={k} style={{marginBottom:3}}>
                    📍 {arr[0].day}曜{arr[0].period}限 {(arr[0].classIds||[]).map(c=>cn(c)).join('・')} →
                    {arr.map(e=>`${e.subject}(${(e.teacherIds||[]).map(t=>tn(t)).join('・')})`).join(' / ')}
                  </div>
                ))}
              </div>
            </div>
          );
        })()}
      </div>
    </div>
  );
}

// ── 📊 StatsModal ──────────────────────────────────────────────────────────────
function StatsModal({base,changes,classes,subjects,getPatDay,getPatPeriod,onClose}){
  const DAYS=['月','火','水','木','金'];
  const PERIODS=[1,2,3,4,5,6];

  // 今年度の開始・終了をデフォルト
  const today=new Date();
  const fy=today.getMonth()<3?today.getFullYear()-1:today.getFullYear();
  const[startDate,setStartDate]=React.useState(`${fy}-04-01`);
  const[endDate,setEndDate]=React.useState(`${fy+1}-03-31`);
  const[result,setResult]=React.useState(null);
  const[tab,setTab]=React.useState('subject'); // 'subject' | 'daytime'
  const[loading,setLoading]=React.useState(false);

  const cn=id=>classes.find(c=>c.id===id)?.name||id;

  const formatD=ds=>{const d=new Date(ds+'T00:00:00');return`${d.getMonth()+1}/${d.getDate()}`;};

  const calculate=()=>{
    setLoading(true);
    setTimeout(()=>{
      const dowOf=ds=>{const w=new Date(ds+'T00:00:00').getDay();return['日','月','火','水','木','金','土'][w];};

      // 集計結果: {byClassSubject: {cid: {subj: count}}, byDayPeriod: {day: {p: count}}, totalDays}
      const byCS={};  // class×subject
      const byDP={};  // day×period
      classes.forEach(c=>{byCS[c.id]={};});
      DAYS.forEach(d=>{byDP[d]={};PERIODS.forEach(p=>{byDP[d][p]=0;});});

      let totalDays=0;
      let d=new Date(startDate+'T00:00:00');
      const end=new Date(endDate+'T00:00:00');

      while(d<=end){
        const ds=`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
        const dow=d.getDay();
        if(dow>=1&&dow<=5){
          totalDays++;
          PERIODS.forEach(p=>{
            classes.forEach(c=>{
              const cid=c.id;

              // 変更エントリを検索（このdate+period+classId）
              const chgs=changes.filter(ch=>ch.date===ds&&ch.period===p&&(ch.classIds||[]).includes(cid));
              const lesson=chgs.find(ch=>!ch._removed&&!ch.isBlocked);
              const blocked=chgs.find(ch=>ch.isBlocked||ch._removed);

              let subj=null;
              if(lesson){
                subj=lesson.subject; // 変更あり
              } else if(blocked){
                subj=null; // 欠課・行事
              } else {
                // ベース時間割を参照（日替え時程も考慮）
                const patDay=getPatDay?getPatDay(ds,p):dowOf(ds);
                const patPer=getPatPeriod?getPatPeriod(ds,p):p;
                if(patDay){
                  const be=base.find(e=>e.day===patDay&&e.period===patPer&&(e.classIds||[]).includes(cid));
                  if(be) subj=be.subject;
                }
              }

              if(subj){
                if(!byCS[cid][subj]) byCS[cid][subj]=0;
                byCS[cid][subj]++;
                const dayName=dowOf(ds);
                if(byDP[dayName]) byDP[dayName][p]=(byDP[dayName][p]||0)+1;
              }
            });
          });
        }
        d.setDate(d.getDate()+1);
      }

      setResult({byCS,byDP,totalDays});
      setLoading(false);
    },50);
  };

  // CSV出力（学級×教科）
  const exportCSV=()=>{
    if(!result)return;
    const usedSubjs=[...new Set(classes.flatMap(c=>Object.keys(result.byCS[c.id]||{})))];
    const rows=[['学級',...usedSubjs,'合計']];
    classes.forEach(c=>{
      const row=[cn(c.id)];
      let total=0;
      usedSubjs.forEach(s=>{const v=result.byCS[c.id]?.[s]||0;row.push(v);total+=v;});
      row.push(total);
      rows.push(row);
    });
    const csv=rows.map(r=>r.join(',')).join('\n');
    const a=document.createElement('a');
    a.href='data:text/csv;charset=utf-8,\uFEFF'+encodeURIComponent(csv);
    a.download=`集計_${startDate}_${endDate}.csv`;
    a.click();
  };

  const usedSubjs=result?[...new Set(classes.flatMap(c=>Object.keys(result.byCS[c.id]||{})))].filter(s=>subjects.includes(s)||true).sort((a,b)=>subjects.indexOf(a)-subjects.indexOf(b)):[];

  return(
    <div onClick={onClose} style={{position:'fixed',inset:0,background:'rgba(0,0,0,0.5)',display:'flex',alignItems:'center',justifyContent:'center',zIndex:9999}}>
      <div onClick={e=>e.stopPropagation()} style={{background:'white',borderRadius:10,width:'min(900px,96vw)',maxHeight:'92vh',display:'flex',flexDirection:'column',boxShadow:'0 10px 40px rgba(0,0,0,0.3)'}}>

        {/* ヘッダー */}
        <div style={{padding:'16px 20px 12px',borderBottom:'1px solid #F1F5F9',flexShrink:0}}>
          <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:12}}>
            <div style={{fontWeight:700,fontSize:18,color:'#0F172A'}}>📊 時間数集計</div>
            <button onClick={onClose} style={{background:'#F1F5F9',border:'none',borderRadius:4,padding:'4px 12px',cursor:'pointer',fontSize:14}}>✕</button>
          </div>
          {/* 期間指定 */}
          <div style={{display:'flex',gap:8,alignItems:'center',flexWrap:'wrap'}}>
            <span style={{fontSize:12,fontWeight:700,color:'#475569'}}>期間：</span>
            <input type="date" value={startDate} onChange={e=>setStartDate(e.target.value)}
              style={{padding:'5px 8px',border:'1.5px solid #E2E8F0',borderRadius:5,fontSize:12}}/>
            <span style={{color:'#94A3B8'}}>〜</span>
            <input type="date" value={endDate} onChange={e=>setEndDate(e.target.value)}
              style={{padding:'5px 8px',border:'1.5px solid #E2E8F0',borderRadius:5,fontSize:12}}/>
            <button onClick={calculate} disabled={loading}
              style={{padding:'6px 18px',background:'#1E3A5F',color:'white',border:'none',borderRadius:5,cursor:'pointer',fontSize:12,fontWeight:700}}>
              {loading?'計算中…':'🔢 計算'}
            </button>
            {result&&<span style={{fontSize:11,color:'#64748B'}}>対象授業日：{result.totalDays}日間</span>}
            {result&&(
              <button onClick={exportCSV}
                style={{padding:'5px 12px',background:'#F0FDF4',color:'#15803D',border:'1px solid #BBF7D0',borderRadius:5,cursor:'pointer',fontSize:11,fontWeight:700,marginLeft:'auto'}}>
                📥 CSV出力
              </button>
            )}
          </div>
          {/* タブ */}
          {result&&(
            <div style={{display:'flex',gap:0,marginTop:10}}>
              {[{v:'subject',l:'📚 学級別 教科時間数'},{v:'daytime',l:'🗓 曜日・時限別 総授業数'}].map(({v,l})=>(
                <button key={v} onClick={()=>setTab(v)}
                  style={{padding:'6px 16px',border:'none',borderRadius:'6px 6px 0 0',cursor:'pointer',fontSize:12,
                    fontWeight:tab===v?700:400,background:tab===v?'#1E3A5F':'#F1F5F9',color:tab===v?'white':'#64748B'}}>
                  {l}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* コンテンツ */}
        <div style={{overflowY:'auto',flex:1,padding:'16px 20px'}}>
          {!result&&(
            <div style={{textAlign:'center',color:'#94A3B8',padding:'60px 0',fontSize:14}}>
              期間を指定して「🔢 計算」を押してください
            </div>
          )}

          {/* 学級別 教科時間数 */}
          {result&&tab==='subject'&&(
            <div style={{overflowX:'auto'}}>
              <table style={{borderCollapse:'collapse',fontSize:12,minWidth:600}}>
                <thead>
                  <tr style={{background:'#F8FAFC'}}>
                    <th style={{padding:'8px 12px',border:'1px solid #E2E8F0',textAlign:'left',fontWeight:700,color:'#1E293B',position:'sticky',left:0,background:'#F8FAFC',minWidth:90}}>学級</th>
                    {usedSubjs.map(s=>(
                      <th key={s} style={{padding:'8px 10px',border:'1px solid #E2E8F0',textAlign:'center',fontWeight:700,color:'#1E293B',minWidth:52,whiteSpace:'nowrap'}}>
                        {s}
                      </th>
                    ))}
                    <th style={{padding:'8px 10px',border:'1px solid #E2E8F0',textAlign:'center',fontWeight:700,color:'#1E3A5F',minWidth:52}}>合計</th>
                  </tr>
                </thead>
                <tbody>
                  {classes.map((c,ci)=>{
                    const row=result.byCS[c.id]||{};
                    const total=Object.values(row).reduce((a,b)=>a+b,0);
                    return(
                      <tr key={c.id} style={{background:ci%2===0?'white':'#F8FAFC'}}>
                        <td style={{padding:'7px 12px',border:'1px solid #E2E8F0',fontWeight:700,color:'#1E293B',position:'sticky',left:0,background:ci%2===0?'white':'#F8FAFC'}}>{cn(c.id)}</td>
                        {usedSubjs.map(s=>{
                          const v=row[s]||0;
                          return(
                            <td key={s} style={{padding:'7px 10px',border:'1px solid #E2E8F0',textAlign:'center',
                              color:v>0?'#1E293B':'#CBD5E1',fontWeight:v>0?600:400}}>
                              {v>0?v:'—'}
                            </td>
                          );
                        })}
                        <td style={{padding:'7px 10px',border:'1px solid #E2E8F0',textAlign:'center',fontWeight:700,color:'#1E3A5F'}}>{total}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {/* 曜日・時限別 総授業数 */}
          {result&&tab==='daytime'&&(
            <div>
              <div style={{fontSize:11,color:'#64748B',marginBottom:10}}>
                全学級の授業コマ数の合計（空き・欠課・行事を除く）
              </div>
              <table style={{borderCollapse:'collapse',fontSize:13}}>
                <thead>
                  <tr style={{background:'#F8FAFC'}}>
                    <th style={{padding:'8px 16px',border:'1px solid #E2E8F0',color:'#1E293B',fontWeight:700}}>時限</th>
                    {DAYS.map(d=>(
                      <th key={d} style={{padding:'8px 20px',border:'1px solid #E2E8F0',textAlign:'center',fontWeight:700,color:'#1E293B'}}>{d}曜</th>
                    ))}
                    <th style={{padding:'8px 16px',border:'1px solid #E2E8F0',textAlign:'center',fontWeight:700,color:'#1E3A5F'}}>合計</th>
                  </tr>
                </thead>
                <tbody>
                  {PERIODS.map((p,pi)=>{
                    const rowTotal=DAYS.reduce((a,d)=>a+(result.byDP[d]?.[p]||0),0);
                    const maxVal=Math.max(...DAYS.map(d=>result.byDP[d]?.[p]||0));
                    return(
                      <tr key={p} style={{background:pi%2===0?'white':'#F8FAFC'}}>
                        <td style={{padding:'8px 16px',border:'1px solid #E2E8F0',fontWeight:700,color:'#475569',textAlign:'center'}}>{p}限</td>
                        {DAYS.map(d=>{
                          const v=result.byDP[d]?.[p]||0;
                          const pct=maxVal>0?v/maxVal:0;
                          return(
                            <td key={d} style={{padding:'8px 20px',border:'1px solid #E2E8F0',textAlign:'center',position:'relative'}}>
                              <div style={{position:'absolute',bottom:0,left:0,right:0,height:`${pct*40}%`,background:'rgba(16,185,129,0.12)',borderRadius:'0 0 2px 2px'}}/>
                              <span style={{position:'relative',fontWeight:v===maxVal?700:400,color:v===maxVal?'#059669':'#1E293B'}}>{v}</span>
                            </td>
                          );
                        })}
                        <td style={{padding:'8px 16px',border:'1px solid #E2E8F0',textAlign:'center',fontWeight:700,color:'#1E3A5F'}}>{rowTotal}</td>
                      </tr>
                    );
                  })}
                  {/* 列合計 */}
                  <tr style={{background:'#F0F9FF',borderTop:'2px solid #E2E8F0'}}>
                    <td style={{padding:'8px 16px',border:'1px solid #E2E8F0',fontWeight:700,color:'#1E3A5F'}}>合計</td>
                    {DAYS.map(d=>{
                      const v=PERIODS.reduce((a,p)=>a+(result.byDP[d]?.[p]||0),0);
                      return(<td key={d} style={{padding:'8px 20px',border:'1px solid #E2E8F0',textAlign:'center',fontWeight:700,color:'#1E3A5F'}}>{v}</td>);
                    })}
                    <td style={{padding:'8px 16px',border:'1px solid #E2E8F0',textAlign:'center',fontWeight:700,color:'#1E3A5F'}}>
                      {PERIODS.reduce((a,p)=>a+DAYS.reduce((b,d)=>b+(result.byDP[d]?.[p]||0),0),0)}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── 🔗 LinkAdjustModal ────────────────────────────────────────────────────────
function LinkAdjustModal({modal,classes,teachers,base,setBase,setMovedIds,setLinkNotice,onClose}){
  const{srcEntry,srcDc,tgtDc,tgt,linkedEntries,adjustItems,linkGroup}=modal;
  const cn=id=>(classes||[]).find(c=>c.id===id)?.name||id;
  const tn=id=>(teachers||[]).find(t=>t.id===id)?.name||id;

  // blocker ごとに選択した移動先
  const[selections,setSelections]=React.useState(()=>{
    const s={};
    adjustItems.forEach(item=>{
      if(item.candidates.length>0){
        s[item.blocker?.id||'x']={day:item.candidates[0].day,period:item.candidates[0].period};
      }
    });
    return s;
  });

  const handleExecute=()=>{
    const ts=Date.now();
    setBase(p=>{
      let next=[...p];
      // 1) srcEntry を tgtDc へ移動
      next=next.map(e=>e.id===srcEntry.id?{...e,day:tgtDc.day,period:tgtDc.period}:e);
      // 2) tgt があればスワップ（srcDc へ）
      if(tgt) next=next.map(e=>e.id===tgt.id?{...e,day:srcDc.day,period:srcDc.period}:e);
      // 3) 各 linkedEntry を tgtDc へ移動
      linkedEntries.forEach(le=>{
        next=next.map(e=>e.id===le.id?{...e,day:tgtDc.day,period:tgtDc.period}:e);
      });
      // 4) 各 blocker を選択した移動先へ移動
      adjustItems.forEach(item=>{
        if(!item.blocker)return;
        const sel=selections[item.blocker.id];
        if(!sel)return;
        next=next.map(e=>e.id===item.blocker.id?{...e,day:sel.day,period:sel.period}:e);
      });
      return next;
    });
    const movedIds=new Set([srcEntry.id,...linkedEntries.map(e=>e.id),...adjustItems.map(i=>i.blocker?.id).filter(Boolean)]);
    if(tgt) movedIds.add(tgt.id);
    setMovedIds(movedIds);
    const names=linkedEntries.map(e=>e.subject).join('・');
    setLinkNotice({text:`🔗 ${names} も ${tgtDc.day}曜${tgtDc.period}限に移動しました`,type:"info"});
    setTimeout(()=>setLinkNotice(null),4000);
    onClose();
  };

  const handleUnlink=()=>{
    setBase(p=>p.map(e=>{
      if(e.id===srcEntry.id)return{...e,day:tgtDc.day,period:tgtDc.period,linkGroup:undefined};
      if(tgt&&e.id===tgt.id)return{...e,day:srcDc.day,period:srcDc.period};
      if(linkGroup&&e.linkGroup===linkGroup&&e.id!==srcEntry.id)return{...e,linkGroup:undefined};
      return e;
    }));
    setMovedIds(new Set([srcEntry.id]));
    setLinkNotice({text:`⚠️ リンクを外して ${srcEntry.subject} のみ移動しました`,type:"warn"});
    setTimeout(()=>setLinkNotice(null),4000);
    onClose();
  };

  return(
    <div onClick={onClose} style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.55)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:9999}}>
      <div onClick={e=>e.stopPropagation()} style={{background:"white",borderRadius:12,width:"min(560px,95vw)",maxHeight:"90vh",overflowY:"auto",boxShadow:"0 16px 48px rgba(0,0,0,0.3)",display:"flex",flexDirection:"column"}}>
        {/* ヘッダー */}
        <div style={{padding:"16px 20px 12px",borderBottom:"1px solid #F1F5F9"}}>
          <div style={{fontWeight:700,fontSize:16,color:"#1E3A5F"}}>🔗 連動移動の調整</div>
          <div style={{fontSize:12,color:"#64748B",marginTop:3}}>連動中の授業の移動先が塞がっています。邪魔している授業の移動先を選んでください。</div>
        </div>
        <div style={{padding:"16px 20px",flex:1}}>
          {/* 移動の概要 */}
          <div style={{background:"#F8FAFC",borderRadius:8,padding:"10px 14px",marginBottom:16,fontSize:12}}>
            <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:4}}>
              <span style={{fontWeight:700,color:"#1E3A5F"}}>{srcEntry.subject}</span>
              <span style={{color:"#64748B"}}>({(srcEntry.classIds||[]).map(c=>cn(c)).join("・")})</span>
              <span style={{color:"#94A3B8"}}>→</span>
              <span style={{fontWeight:700,color:"#059669"}}>{tgtDc.day}曜{tgtDc.period}限 ✅</span>
            </div>
            {linkedEntries.map(le=>(
              <div key={le.id} style={{display:"flex",alignItems:"center",gap:8,marginBottom:4}}>
                <span style={{fontWeight:700,color:"#1E3A5F"}}>🔗 {le.subject}</span>
                <span style={{color:"#64748B"}}>({(le.classIds||[]).map(c=>cn(c)).join("・")})</span>
                <span style={{color:"#94A3B8"}}>→</span>
                <span style={{fontWeight:700,color:"#059669"}}>{tgtDc.day}曜{tgtDc.period}限</span>
                <span style={{color:"#EF4444",fontSize:11}}>⚠ 調整必要</span>
              </div>
            ))}
          </div>

          {/* 各邪魔エントリの移動先選択 */}
          {adjustItems.map((item,i)=>(
            <div key={i} style={{marginBottom:16,padding:"12px 14px",border:"1.5px solid #FDE68A",borderRadius:8,background:"#FFFBEB"}}>
              <div style={{fontSize:12,fontWeight:700,color:"#92400E",marginBottom:8}}>
                ⚠️ <span style={{color:"#1E293B"}}>{item.blocker?.subject}</span>
                （{(item.blocker?.classIds||[]).map(c=>cn(c)).join("・")}・{(item.blocker?.teacherIds||[]).map(t=>tn(t)).join("・")}先生）
                を {tgtDc.day}曜{tgtDc.period}限から退かす
              </div>
              <div style={{fontSize:11,color:"#64748B",marginBottom:8}}>移動先を選択：</div>
              <div style={{display:"flex",flexWrap:"wrap",gap:6}}>
                {item.candidates.slice(0,10).map((cand,ci)=>{
                  const sel=selections[item.blocker?.id];
                  const isSelected=sel&&sel.day===cand.day&&sel.period===cand.period;
                  return(
                    <button key={ci} onClick={()=>setSelections(p=>({...p,[item.blocker?.id]:{day:cand.day,period:cand.period}}))}
                      style={{padding:"5px 12px",border:`1.5px solid ${isSelected?"#1E3A5F":"#CBD5E1"}`,borderRadius:6,cursor:"pointer",
                        fontSize:12,fontWeight:isSelected?700:400,
                        background:isSelected?"#1E3A5F":cand.recommended?"#EFF6FF":"white",
                        color:isSelected?"white":cand.recommended?"#1D4ED8":"#374151"}}>
                      {cand.recommended?"↩ ":""}
                      {cand.day}曜{cand.period}限
                      {cand.recommended?<span style={{fontSize:10,marginLeft:3}}>(推奨)</span>:null}
                    </button>
                  );
                })}
                {item.candidates.length===0&&(
                  <span style={{fontSize:12,color:"#EF4444"}}>移動できる空きスロットがありません</span>
                )}
              </div>
            </div>
          ))}
        </div>

        {/* フッター */}
        <div style={{padding:"12px 20px",borderTop:"1px solid #F1F5F9",display:"flex",gap:8}}>
          <button onClick={handleExecute}
            style={{flex:1,padding:"10px",background:"#1E3A5F",color:"white",border:"none",borderRadius:7,cursor:"pointer",fontSize:14,fontWeight:700}}>
            🔗 この配置で実行
          </button>
          <button onClick={handleUnlink}
            style={{padding:"10px 14px",background:"#FEF3C7",color:"#92400E",border:"1px solid #FDE68A",borderRadius:7,cursor:"pointer",fontSize:12,fontWeight:700}}>
            リンクを外して移動
          </button>
          <button onClick={onClose}
            style={{padding:"10px 14px",background:"#F1F5F9",color:"#64748B",border:"none",borderRadius:7,cursor:"pointer",fontSize:13,fontWeight:700}}>
            ✕
          </button>
        </div>
      </div>
    </div>
  );
}

// ── AdminManager（管理者管理モーダル）─────────────────────────────────────────
// メールアドレスで管理者を追加・削除。最後の1人（＝自分しかいない場合）は削除不可。
function AdminManagerModal({currentEmail,onClose}){
  const[list,setList]=React.useState(null); // null=読み込み中
  const[input,setInput]=React.useState("");
  const[busy,setBusy]=React.useState(false);
  const[error,setError]=React.useState("");

  const reload=async()=>{
    try{
      const rows=await sbListAdmins();
      setList(Array.isArray(rows)?rows.map(r=>r.email):[]);
    }catch(e){setError("一覧の取得に失敗しました");setList([]);}
  };
  React.useEffect(()=>{reload();},[]);

  const normalize=(s)=>String(s||"").trim().toLowerCase();

  const handleAdd=async()=>{
    const email=normalize(input);
    setError("");
    if(!email){return;}
    if(!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)){setError("メールアドレスの形式が正しくありません");return;}
    if((list||[]).map(normalize).includes(email)){setError("すでに登録されています");return;}
    setBusy(true);
    try{
      const res=await sbAddAdmin(email);
      if(!res.ok&&res.status!==201){setError("追加できませんでした（権限をご確認ください）");}
      else{setInput("");await reload();}
    }catch(e){setError("追加に失敗しました");}
    setBusy(false);
  };

  const handleRemove=async(email)=>{
    setError("");
    // 最後の1人は削除不可
    if((list||[]).length<=1){setError("管理者が1人のときは削除できません");return;}
    if(!window.confirm(email+" を管理者から削除しますか？")){return;}
    setBusy(true);
    try{
      const res=await sbRemoveAdmin(email);
      if(!res.ok&&res.status!==204){setError("削除できませんでした");}
      else{await reload();}
    }catch(e){setError("削除に失敗しました");}
    setBusy(false);
  };

  return(
    <div onClick={onClose} style={{position:"fixed",inset:0,background:"rgba(15,23,42,0.45)",zIndex:600,
      display:"flex",alignItems:"center",justifyContent:"center"}}>
      <div onClick={e=>e.stopPropagation()} style={{background:"#fff",borderRadius:12,width:480,maxWidth:"92vw",
        maxHeight:"85vh",overflow:"auto",boxShadow:"0 12px 48px rgba(0,0,0,0.25)"}}>
        {/* ヘッダー */}
        <div style={{padding:"16px 20px",borderBottom:"1px solid #E2E8F0",display:"flex",
          alignItems:"center",justifyContent:"space-between"}}>
          <div style={{fontWeight:800,fontSize:16,color:"#1E293B"}}>👤 管理者の管理</div>
          <button onClick={onClose} style={{background:"none",border:"none",fontSize:22,cursor:"pointer",color:"#94A3B8"}}>×</button>
        </div>

        <div style={{padding:"18px 20px"}}>
          <div style={{fontSize:12,color:"#64748B",marginBottom:14,lineHeight:1.6}}>
            登録したメールアドレスの人が、Googleでログインすると管理者として編集できます。
          </div>

          {/* 追加フォーム */}
          <div style={{display:"flex",gap:8,marginBottom:8}}>
            <input value={input} onChange={e=>setInput(e.target.value)}
              onKeyDown={e=>{if(e.key==="Enter")handleAdd();}}
              placeholder="例: teacher@tonami-city.ed.jp"
              style={{flex:1,padding:"9px 12px",border:"1.5px solid #CBD5E1",borderRadius:8,fontSize:13}}/>
            <button onClick={handleAdd} disabled={busy}
              style={{padding:"9px 18px",background:"#0F766E",color:"#fff",border:"none",borderRadius:8,
                fontSize:13,fontWeight:700,cursor:busy?"default":"pointer",opacity:busy?0.6:1}}>
              追加
            </button>
          </div>
          {error&&<div style={{color:"#DC2626",fontSize:12,marginBottom:10}}>{error}</div>}

          {/* 一覧 */}
          <div style={{marginTop:12}}>
            {list===null?(
              <div style={{color:"#94A3B8",fontSize:13,padding:"12px 0"}}>読み込み中…</div>
            ):list.length===0?(
              <div style={{color:"#94A3B8",fontSize:13,padding:"12px 0"}}>管理者が登録されていません</div>
            ):(
              <div style={{display:"flex",flexDirection:"column",gap:6}}>
                {list.map(email=>{
                  const isSelf=normalize(email)===normalize(currentEmail);
                  const onlyOne=list.length<=1;
                  return(
                    <div key={email} style={{display:"flex",alignItems:"center",justifyContent:"space-between",
                      padding:"10px 12px",border:"1px solid #E2E8F0",borderRadius:8,background:isSelf?"#F0FDF4":"#fff"}}>
                      <span style={{fontSize:13,color:"#1E293B"}}>
                        {email}{isSelf&&<span style={{color:"#15803D",fontSize:11,marginLeft:6}}>（あなた）</span>}
                      </span>
                      <button onClick={()=>handleRemove(email)} disabled={busy||onlyOne}
                        title={onlyOne?"管理者が1人のときは削除できません":"削除"}
                        style={{padding:"4px 10px",background:onlyOne?"#F1F5F9":"#FEF2F2",
                          color:onlyOne?"#94A3B8":"#DC2626",border:"1px solid "+(onlyOne?"#E2E8F0":"#FCA5A5"),
                          borderRadius:6,fontSize:12,cursor:(busy||onlyOne)?"default":"pointer"}}>
                        削除
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── ConflictTrialPanel ────────────────────────────────────────────────────────
// ドロップ後に右からスライドインするトライアルパネル
// ステップ: select（候補選択） → preview（適用済み確認中） → done（確定済み）
function ConflictTrialPanel({modal,classes,teachers,dateMode,onClose,onUndo,onMinimizeChange}){
  const{srcEntry,srcDc,tgtDc,hasClassConflict,hasTeacherConflict,conflictItems,
        onForce,onMoveConflict,onPreviewConflict,onPreviewChainConflict,onConfirmAfterPreview,
        onResolveConflictOnly,onResolveChainOnly,onPlaceMain,onApplyResolved,
        onHoverCandidate,onLeaveCandidate,onPulseCells,onFocusSlot}=modal;

  // step: 'select' | 'preview' | 'done'
  const[step,setStep]=React.useState('select');
  // プレビュー中の候補情報
  const[previewItem,setPreviewItem]=React.useState(null); // {item, slot}
  // 重複相手ごとの解消内容（複数重複対応）: { [itemIndex]: {slot, chain?} }
  const[resolvedMap,setResolvedMap]=React.useState({});
  const[deepByIdx,setDeepByIdx]=React.useState({}); // i → 深い探索で見つかった候補配列
  const[deepLoading,setDeepLoading]=React.useState(null); // 探索中の item index
  // 「深く探す」: 重い探索を押下時のみ実行。setTimeout で先に「探索中」を描画してから走らせる。
  const handleDeepSearch=(item,idx)=>{
    if(!item.runDeep)return;
    setDeepLoading(idx);
    setTimeout(()=>{
      let res=[];
      try{res=item.runDeep()||[];}catch(_){res=[];}
      setDeepByIdx(m=>({...m,[idx]:res}));
      setDeepLoading(null);
    },30);
  };
  const[visible,setVisible]=React.useState(false);
  // パネルをたたんで後ろの時間割を確認するモード
  const[minimized,setMinimized]=React.useState(false);
  React.useEffect(()=>{onMinimizeChange?.(minimized);},[minimized]);

  // マウント時にスライドイン＋主役を先に移動先へ配置（盤面で重複状態を見せる）
  React.useEffect(()=>{
    const t=setTimeout(()=>setVisible(true),20);
    // 主役を移動先へ置く（重複相手を解消するたびに盤面が片付いていく）
    onPlaceMain&&onPlaceMain();
    return()=>clearTimeout(t);
  },[]);

  const cn=id=>classes.find(c=>c.id===id)?.name||id;
  const tn=id=>teachers.find(t=>t.id===id)?.name||id;

  const slotLabel=(slot)=>{
    if(!slot)return '';
    if(slot.date){
      const d=new Date(slot.date+"T00:00:00");
      return`${d.getMonth()+1}/${d.getDate()}（${["日","月","火","水","木","金","土"][d.getDay()]}）${slot.period}限`;
    }
    return`${slot.day}曜${slot.period}限`;
  };
  const entryLabel=(e)=>{
    if(!e)return '';
    const cls=(e.classIds||[]).map(cn).join('・');
    const tch=(e.teacherIds||[]).map(tn).join('・');
    return`${e.subject}（${cls}）${tch?tch+'先生':''}`;
  };
  // 重複の種類に応じて、衝突している側（学級 or 先生）を色付けして表示
  const entryLabelColored=(e,type)=>{
    if(!e)return null;
    const cls=(e.classIds||[]).map(cn).join('・');
    const tch=(e.teacherIds||[]).map(tn).join('・');
    const clsColor=type==='class'?'#DC2626':'#475569';
    const tchColor=type==='teacher'?'#D97706':'#475569';
    const clsWeight=type==='class'?800:600;
    const tchWeight=type==='teacher'?800:600;
    return(
      <span style={{fontSize:12}}>
        {e.subject}（<span style={{color:clsColor,fontWeight:clsWeight}}>{cls}</span>）
        {tch&&<span style={{color:tchColor,fontWeight:tchWeight}}>{tch}先生</span>}
      </span>
    );
  };

  const conflictColor=hasClassConflict&&hasTeacherConflict?'#7C3AED':hasClassConflict?'#DC2626':'#D97706';
  const conflictTitle=hasClassConflict&&hasTeacherConflict?'学級・先生が重複':hasClassConflict?'学級が重複':'先生が重複';

  // 重複相手は必ずドロップ先と同じスロットにいるため、ドロップ先(tgtDc)の日付・時限を使う
  // （base エントリには date が無いため item.entry.date を使うと undefined になり相手が消えない）
  const jpDow=(d)=>d?["日","月","火","水","木","金","土"][new Date(d+"T00:00:00").getDay()]:undefined;
  // 【v8_7_31】item.entry が基本時間割の授業（変更なし）の場合、day(曜日)しか持たず date(日付) が無いため、
  //   点滅の照合(日付ベース)に失敗して光らなかった。tgtDc.date と同じ週の中から、指定の曜日に対応する
  //   実際の日付を逆算して補う。
  const dateForDayInWeekOf=(anchorDateStr,day)=>{
    if(!anchorDateStr||!day)return null;
    const JP=["日","月","火","水","木","金","土"];
    const idx=JP.indexOf(day);
    if(idx<0)return null;
    const anchor=new Date(anchorDateStr+"T00:00:00");
    const diff=idx-anchor.getDay();
    const d=new Date(anchor);d.setDate(anchor.getDate()+diff);
    const pad=n=>String(n).padStart(2,"0");
    return`${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
  };

  // ── 連鎖カードのハイライト用ヘルパ ──────────────────────────────────────
  // 1つの駒×スロットを、ハイライト用セル指定に変換（kind: 'from'=出発 / 'to'=到着）
  const mkCell=(e,slot,kind)=>({
    date:slot.date||null,
    day:slot.day||(slot.date?jpDow(slot.date):tgtDc.day),
    period:slot.period,
    tids:e.teacherIds||[],cids:e.classIds||[],kind,
  });
  // この連鎖手で動く全駒の出発/到着セルを列挙（主役＋重複相手＋玉突き各手）
  const buildChainCells=(item,cc)=>{
    const cells=[];
    if(srcEntry){cells.push(mkCell(srcEntry,srcDc,'from'));cells.push(mkCell(srcEntry,tgtDc,'to'));}
    cells.push(mkCell(item.entry,tgtDc,'from'));
    cells.push(mkCell(item.entry,cc.slot,'to'));
    (cc.steps||[]).forEach(st=>{cells.push(mkCell(st.entry,st.from,'from'));cells.push(mkCell(st.entry,st.to,'to'));});
    return cells;
  };
  // スロット表記を、ホバーでそのセルだけ点滅させる下線付きラベルにする。
  // 離れたらカード全体のハイライト(fullCells)へ戻す。
  const SlotChip=({piece,slot,kind,fullCells})=>(
    <b style={{cursor:'help',textDecoration:'underline dotted',textUnderlineOffset:2}}
       onMouseEnter={()=>{onFocusSlot&&onFocusSlot(slot);onPulseCells&&onPulseCells([mkCell(piece,slot,kind)]);}}
       onMouseLeave={()=>onPulseCells&&onPulseCells(fullCells)}>
      {slotLabel(slot)}
    </b>
  );

  // 全ての重複相手が解消済みかどうか
  const allResolved=(map)=>conflictItems.every((_,i)=>map[i]);

  // 全件解消できたらプレビューへ進む（主役はマウント時に配置済み）
  const finishIfAllResolved=(map)=>{
    if(allResolved(map)){
      setPreviewItem({multi:true,resolved:map});
      setStep('preview');
    }
  };

  // 解消済みマップ → 原子的適用に渡すリスト（学級/先生エントリと移動先・玉突き手順）
  const buildResolvedList=(map)=>Object.keys(map)
    .sort((a,b)=>Number(a)-Number(b))
    .map(k=>({entry:map[k].item.entry,slot:map[k].slot,chain:map[k].chain}));

  // 候補を選んで重複相手を解消。
  // 週間: 主役＋解消済み相手＋玉突き各手の最終位置を一度に原子的適用（マーカー消し合いを回避）。
  // 基本: 従来どおり1件ずつ逐次移動（base の id 再配置のため衝突しない）。
  const handleSelectCandidate=(item,slot,idx)=>{
    onLeaveCandidate&&onLeaveCandidate();
    const map={...resolvedMap,[idx]:{item,slot}};
    setResolvedMap(map);
    if(dateMode){
      onApplyResolved&&onApplyResolved(buildResolvedList(map));
    }else{
      const conflictDc={day:tgtDc.day,period:tgtDc.period};
      onResolveConflictOnly&&onResolveConflictOnly(item.entry,conflictDc,slot);
    }
    finishIfAllResolved(map);
  };

  // 玉突き候補で重複相手を解消（分岐は handleSelectCandidate と同じ）
  const handleSelectChainCandidate=(item,cc,idx)=>{
    onLeaveCandidate&&onLeaveCandidate();
    const map={...resolvedMap,[idx]:{item,slot:cc.slot,chain:cc}};
    setResolvedMap(map);
    if(dateMode){
      onApplyResolved&&onApplyResolved(buildResolvedList(map));
    }else{
      const conflictDc={day:tgtDc.day,period:tgtDc.period};
      onResolveChainOnly&&onResolveChainOnly(item.entry,conflictDc,cc);
    }
    finishIfAllResolved(map);
  };

  // 強制配置
  const handleForce=()=>{
    onForce();
    setStep('done');
    setTimeout(()=>onClose(),1200);
  };

  // プレビューをやり直し（undoして戻る）
  const handleRetry=()=>{
    onUndo();
    setPreviewItem(null);
    setResolvedMap({});
    setStep('select');
    // 週間: 主役だけ移動先へ戻し、重複を見せた状態から選び直せるようにする
    if(dateMode&&onApplyResolved){
      setTimeout(()=>onApplyResolved([]),0);
    }
  };

  // プレビューを確定（サマリーを組み立てて親へ）
  const handleConfirm=()=>{
    const lines=[];
    const lbl=e=>`${e.subject}（${(e.classIds||[]).map(cn).join('・')}）`;
    let n=1;
    conflictItems.forEach((it,i)=>{
      const r=resolvedMap[i];
      if(!r)return;
      if(r.chain&&(r.chain.steps||[]).length){
        (r.chain.steps||[]).forEach(st=>{
          lines.push(`${n++}. ↪どかす ${lbl(st.entry)}${slotLabel(st.from)} → ${slotLabel(st.to)}`);
        });
      }
      lines.push(`${n++}. ${lbl(it.entry)}${slotLabel(tgtDc)} → ${slotLabel(r.slot)}`);
    });
    lines.push(`${n++}. ${lbl(srcEntry)}${slotLabel(srcDc)} → ${slotLabel(tgtDc)}`);
    onConfirmAfterPreview(lines);
    setStep('done');
    setTimeout(()=>onClose(),1200);
  };

  const panelW=400;

  // ── 共通スタイル ──
  const pill=(bg,color,text)=>(
    <span style={{background:bg,color,borderRadius:4,padding:'2px 8px',
      fontSize:10,fontWeight:700,marginRight:4}}>{text}</span>
  );

  // ── step: select ──────────────────────────────────────────────────────────
  const renderSelect=()=>(
    <>
      {/* 移動する駒の情報 */}
      <div style={{background:'#EFF6FF',borderRadius:8,padding:'10px 14px',fontSize:12,marginBottom:14}}>
        <div style={{color:'#1D4ED8',fontWeight:700,marginBottom:3}}>移動する駒</div>
        <div style={{color:'#1E293B',fontWeight:600}}>{entryLabel(srcEntry)}</div>
        <div style={{color:'#64748B',marginTop:2,fontSize:11}}>
          <b style={{cursor:'help',textDecoration:'underline dotted',textUnderlineOffset:2}}
             onMouseEnter={()=>{onFocusSlot&&onFocusSlot(srcDc);onPulseCells&&onPulseCells([mkCell(srcEntry,srcDc,'from')]);}}
             onMouseLeave={()=>onPulseCells&&onPulseCells(null)}>{slotLabel(srcDc)}</b>
          {' → '}
          <b style={{color:'#1D4ED8',cursor:'help',textDecoration:'underline dotted',textUnderlineOffset:2}}
             onMouseEnter={()=>{onFocusSlot&&onFocusSlot(tgtDc);onPulseCells&&onPulseCells([mkCell(srcEntry,tgtDc,'to')]);}}
             onMouseLeave={()=>onPulseCells&&onPulseCells(null)}>{slotLabel(tgtDc)}</b>
        </div>
      </div>

      {/* 重複が複数あるときの進捗 */}
      {conflictItems.length>1&&(
        <div style={{fontSize:11,color:conflictColor,fontWeight:700,marginBottom:8}}>
          重複 {conflictItems.length} 件：{Object.keys(resolvedMap).length} 件 解消済み（すべて解消すると自動でプレビューへ進みます）
        </div>
      )}

      {/* 重複相手ごとの解消候補 */}
      <div style={{flex:1,overflowY:'auto',display:'flex',flexDirection:'column',gap:12}}>
        {conflictItems.map((item,i)=>{
          const resolved=resolvedMap[i];
          // 既に他の相手が使った移動先は候補から除外（相手どうしの衝突回避）
          const usedKeys=new Set(Object.entries(resolvedMap).filter(([k])=>Number(k)!==i).map(([,r])=>`${r.slot.day||''}-${r.slot.date||''}-${r.slot.period}`));
          const cands=(item.moveCandidates||[]).filter(s=>!usedKeys.has(`${s.day||''}-${s.date||''}-${s.period}`));
          const chainAll=[...(item.chainCandidates||[]),...(deepByIdx[i]||[])]; // 通常＋深い探索の候補
          return(
          <div key={item.entry.id||i} style={{
            border:`2px solid ${resolved?'#86EFAC':item.type==='class'?'#FCA5A5':'#FCD34D'}`,
            borderRadius:10,padding:'12px 14px',background:resolved?'#F0FDF4':'white'}}>
            <div style={{display:'flex',alignItems:'center',gap:6,marginBottom:8,flexWrap:'wrap'}}>
              <span
                onMouseEnter={()=>onPulseCells&&onPulseCells([mkCell(item.entry,{
                  day:item.entry.day,
                  period:item.entry.period,
                  date:item.entry.date||dateForDayInWeekOf(tgtDc.date,item.entry.day),
                },'from')])}
                onMouseLeave={()=>onPulseCells&&onPulseCells(null)}
                style={{display:'inline-flex',alignItems:'center',gap:6,cursor:onPulseCells?'pointer':'default',borderRadius:4,padding:'1px 2px'}}>
                {resolved?pill('#DCFCE7','#15803D','✓ 解消済み'):item.type==='class'?pill('#FEE2E2','#DC2626','🏫 学級重複'):pill('#FEF3C7','#D97706','👤 先生重複')}
                <span style={{fontWeight:600,textDecoration:onPulseCells?"underline dotted":"none"}}>{entryLabelColored(item.entry,item.type)}</span>
                <span style={{fontSize:10,color:'#94A3B8'}}>
                  ({slotLabel({day:item.entry.day,period:item.entry.period,date:item.entry.date})})
                </span>
              </span>
            </div>
            {resolved?(
              <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',gap:8}}>
                <div style={{fontSize:12,color:'#15803D',fontWeight:700}}>
                  {resolved.chain&&<span style={{color:'#92400E'}}>↪ {(resolved.chain.steps||[]).map(st=>st.entry.subject).join('→')}をどかして </span>}
                  → {slotLabel(resolved.slot)} へ移動
                </div>
                <button onClick={()=>{handleRetry();}}
                  style={{flexShrink:0,fontSize:11,padding:'4px 10px',border:'1px solid #E2E8F0',borderRadius:5,cursor:'pointer',background:'white',color:'#64748B'}}>選び直す</button>
              </div>
            ):cands.length>0?(
              <>
                <div style={{fontSize:10,color:'#64748B',marginBottom:6}}>📌 この駒を移動できる空きスロット{item._holeSlot&&<span style={{color:'#B45309'}}>（★＝主役が抜けて空いた枠を埋めます）</span>}</div>
                <div style={{display:'flex',flexWrap:'wrap',gap:6}}>
                  {cands.map((slot,si)=>{
                    const fills=item._holeSlot&&((item._holeSlot.date&&slot.date)?item._holeSlot.date===slot.date:item._holeSlot.day===slot.day)&&item._holeSlot.period===slot.period;
                    return(
                    <button key={si}
                      onClick={()=>handleSelectCandidate(item,slot,i)}
                      style={{padding:'6px 12px',background:fills?'#FEF3C7':'#F0FDF4',border:`1.5px solid ${fills?'#F59E0B':'#86EFAC'}`,
                        borderRadius:6,fontSize:12,cursor:'pointer',color:fills?'#B45309':'#15803D',fontWeight:fills?800:600,
                        transition:'all 0.12s'}}
                      onMouseEnter={e=>{e.target.style.transform='translateY(-1px)';onHoverCandidate&&onHoverCandidate(item,slot);}}
                      onMouseLeave={e=>{e.target.style.transform='none';onLeaveCandidate&&onLeaveCandidate();}}>
                      {fills?'★ ':'▶ '}{slotLabel(slot)}
                    </button>
                    );
                  })}
                </div>
              </>
            ):(
              <div style={{fontSize:11,color:'#94A3B8',padding:'4px 0'}}>空き時限が見つかりませんでした</div>
            )}
            {!resolved&&chainAll.length>0&&(
              <>
                <div style={{fontSize:10,color:'#B45309',marginTop:10,marginBottom:6}}>
                  🧩 玉突き（連鎖）：塞いでいる駒をどかせば移動できる枠
                </div>
                <div style={{fontSize:10,color:'#64748B',marginBottom:6,display:'flex',gap:10,flexWrap:'wrap',alignItems:'center'}}>
                  <span>候補にカーソルを合わせると盤面が光ります：</span>
                  <span style={{display:'inline-flex',alignItems:'center',gap:3}}><span style={{display:'inline-block',width:10,height:10,borderRadius:2,border:'2px solid #D97706',background:'#FEF3C7'}}/>出発</span>
                  <span style={{display:'inline-flex',alignItems:'center',gap:3}}><span style={{display:'inline-block',width:10,height:10,borderRadius:2,border:'2px solid #16A34A',background:'#DCFCE7'}}/>到着</span>
                  <span style={{display:'inline-flex',alignItems:'center',gap:3}}><span style={{display:'inline-block',width:10,height:10,borderRadius:2,border:'2px solid #2563EB',background:'#DBEAFE'}}/>入れ替わり</span>
                </div>
                <div style={{display:'flex',flexDirection:'column',gap:6}}>
                  {chainAll.map((cc,ci)=>{
                    const v=cc._verify;
                    const clean=v?v.ok:true;
                    const fullCells=buildChainCells(item,cc);
                    return(
                    <button key={ci}
                      onClick={()=>handleSelectChainCandidate(item,cc,i)}
                      style={{padding:'7px 10px',background:clean?'#F0FDF4':'#FFFBEB',border:`1.5px solid ${clean?'#86EFAC':'#FCD34D'}`,
                        borderRadius:6,fontSize:11,cursor:'pointer',color:clean?'#15803D':'#92400E',fontWeight:600,
                        textAlign:'left',lineHeight:1.5,transition:'all 0.12s'}}
                      onMouseEnter={e=>{e.currentTarget.style.background=clean?'#DCFCE7':'#FEF3C7';onPulseCells&&onPulseCells(fullCells);}}
                      onMouseLeave={e=>{e.currentTarget.style.background=clean?'#F0FDF4':'#FFFBEB';onPulseCells&&onPulseCells(null);}}>
                      {clean
                        ? <div style={{color:'#15803D',fontWeight:800,marginBottom:3}}>★ 完全に解消（空き・重複なし）</div>
                        : <div style={{color:'#B45309',fontWeight:800,marginBottom:3}}>⚠ 次の副作用が出ます{v&&v.holes.length>0?`：${v.holes.join('・')}に空きができます`:''}{v&&v.teacherConflicts.length>0?`／${v.teacherConflicts.join('・')}先生が重複します`:''}{v&&v.classConflicts.length>0?`／${v.classConflicts.join('・')}が重複します`:''}</div>}
                      {(()=>{const s$=[...(cc.steps||[])].reverse();
                        const meLbl=`${item.entry.subject}（${(item.entry.classIds||[]).map(cn).join('・')}・${(item.entry.teacherIds||[]).map(tn).join('・')}先生）`;
                        return(<>
                        1. <b>{meLbl}</b>を <SlotChip piece={item.entry} slot={tgtDc} kind="from" fullCells={fullCells}/> → <SlotChip piece={item.entry} slot={cc.slot} kind="to" fullCells={fullCells}/> へ移動<br/>
                        {s$.map((st,si)=>(
                          <React.Fragment key={si}>
                            {si+2}. {st.entry.subject}（{(st.entry.classIds||[]).map(cn).join('・')}・{(st.entry.teacherIds||[]).map(tn).join('・')}先生）を <SlotChip piece={st.entry} slot={st.from} kind="from" fullCells={fullCells}/> → <SlotChip piece={st.entry} slot={st.to} kind="to" fullCells={fullCells}/> へどかす{si<s$.length-1?<br/>:null}
                          </React.Fragment>
                        ))}
                      </>);})()}
                    </button>
                    );
                  })}
                </div>
              </>
            )}
            {!resolved&&dateMode&&item.runDeep&&deepByIdx[i]===undefined&&(
              <div style={{marginTop:10}}>
                <button disabled={deepLoading!=null}
                  onClick={()=>handleDeepSearch(item,i)}
                  style={{width:'100%',padding:'8px',background:deepLoading===i?'#EEF2FF':'#F8FAFC',
                    color:deepLoading!=null?'#94A3B8':'#4338CA',border:'1.5px solid #C7D2FE',borderRadius:7,
                    cursor:deepLoading!=null?'wait':'pointer',fontSize:12,fontWeight:700}}>
                  {deepLoading===i?'⏳ 深く探しています…（十数秒かかることがあります）':'🔍 深く探す（時間がかかります）'}
                </button>
                <div style={{fontSize:10,color:'#94A3B8',marginTop:4}}>
                  通常の候補で足りないとき、数手の長い玉突きまで探します。探索中は画面が一時的に固まることがあります。
                </div>
              </div>
            )}
            {!resolved&&deepByIdx[i]&&deepByIdx[i].length===0&&(
              <div style={{fontSize:11,color:'#94A3B8',marginTop:8}}>深く探しても候補は見つかりませんでした。</div>
            )}
          </div>
          );
        })}
      </div>

      {/* フッターボタン */}
      <div style={{borderTop:'1px solid #E2E8F0',paddingTop:12,marginTop:12,display:'flex',flexDirection:'column',gap:8}}>
        <button onClick={handleForce}
          style={{width:'100%',padding:'10px',background:'#FEF2F2',color:'#DC2626',
            border:'1.5px solid #FCA5A5',borderRadius:7,cursor:'pointer',fontSize:13,fontWeight:700}}>
          ⚠ 重複のまま強制配置
        </button>
        <button onClick={()=>{onUndo();onClose();}}
          style={{width:'100%',padding:'9px',background:'#F8FAFC',color:'#64748B',
            border:'1.5px solid #E2E8F0',borderRadius:7,cursor:'pointer',fontSize:13}}>
          ✕ キャンセル（移動を取り消す）
        </button>
      </div>
    </>
  );

  // ── step: preview ──────────────────────────────────────────────────────────
  const renderPreview=()=>(
    <>
      {/* プレビュー適用済み表示 */}
      <div style={{background:'#F0FDF4',border:'2px solid #86EFAC',borderRadius:10,
        padding:'14px',marginBottom:16,fontSize:12}}>
        <div style={{color:'#15803D',fontWeight:700,fontSize:13,marginBottom:8}}>
          ✅ 重複を解消して試験的に移動しました
        </div>
        {conflictItems.map((it,i)=>{
          const r=resolvedMap[i];
          if(!r)return null;
          return(
            <div key={i} style={{color:'#166534',marginBottom:4}}>
              {r.chain&&(r.chain.steps||[]).map((st,si)=>(
                <div key={si} style={{color:'#92400E',fontSize:11}}>↪ {st.entry.subject}（{(st.entry.classIds||[]).map(cn).join('・')}）を {slotLabel(st.from)} → {slotLabel(st.to)} へどかす</div>
              ))}
              <span style={{fontWeight:700}}>{it.type==='class'?'学級重複':'先生重複'}：</span>
              {it.entry.subject}（{(it.entry.classIds||[]).map(cn).join('・')}）{slotLabel(tgtDc)} → <b>{slotLabel(r.slot)}</b>
            </div>
          );
        })}
        <div style={{color:'#94A3B8',marginTop:8,fontSize:11,borderTop:'1px solid #D1FAE5',paddingTop:8}}>
          時間割に変更が反映されています。このまま確定しますか？
        </div>
      </div>

      {/* 確定対象の駒 */}
      <div style={{background:'#EFF6FF',borderRadius:8,padding:'10px 14px',fontSize:12,marginBottom:16}}>
        <div style={{color:'#1D4ED8',fontWeight:700,marginBottom:3}}>移動する駒（反映済み）</div>
        <div style={{color:'#1E293B',fontWeight:600}}>{entryLabel(srcEntry)}</div>
        <div style={{color:'#64748B',marginTop:2,fontSize:11}}><b>{slotLabel(srcDc)}</b> → <b style={{color:'#1D4ED8'}}>{slotLabel(tgtDc)}</b></div>
      </div>

      {/* アクションボタン */}
      <div style={{display:'flex',flexDirection:'column',gap:10,marginTop:'auto'}}>
        <button onClick={handleConfirm}
          style={{width:'100%',padding:'12px',background:'#0F766E',color:'white',
            border:'none',borderRadius:8,cursor:'pointer',fontSize:14,fontWeight:700,
            boxShadow:'0 2px 8px rgba(15,118,110,0.3)',transition:'all 0.12s'}}
          onMouseEnter={e=>e.target.style.background='#0D9488'}
          onMouseLeave={e=>e.target.style.background='#0F766E'}>
          ✓ この配置で確定する
        </button>
        <button onClick={handleRetry}
          style={{width:'100%',padding:'10px',background:'#FFF7ED',color:'#C2410C',
            border:'1.5px solid #FED7AA',borderRadius:8,cursor:'pointer',fontSize:13,fontWeight:600}}>
          ↩ やり直し（別の候補を選ぶ）
        </button>
        <button onClick={()=>{onUndo();onClose();}}
          style={{width:'100%',padding:'9px',background:'#F8FAFC',color:'#64748B',
            border:'1.5px solid #E2E8F0',borderRadius:7,cursor:'pointer',fontSize:12}}>
          ✕ 全てキャンセル
        </button>
      </div>
    </>
  );

  // ── step: done ─────────────────────────────────────────────────────────────
  const renderDone=()=>(
    <div style={{display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',
      flex:1,gap:16,color:'#0F766E'}}>
      <div style={{fontSize:48}}>✅</div>
      <div style={{fontSize:16,fontWeight:700}}>移動を確定しました</div>
      <div style={{fontSize:12,color:'#64748B'}}>パネルを閉じています…</div>
    </div>
  );

  return(
    <>
      {/* オーバーレイ: パネルを開いたまま左側の時間割を操作できるよう、クリックを透過する */}
      <div
        style={{
          position:'fixed',inset:0,
          background:'transparent',
          zIndex:598,
          // 常にクリック透過（時間割の操作・スクロール・タブ切替を妨げない）
          pointerEvents:'none',
        }}
      />
      {/* たたみ中の再表示ボタン */}
      {minimized&&(
        <button onClick={()=>setMinimized(false)}
          style={{
            position:'fixed',top:'50%',right:0,transform:'translateY(-50%)',
            zIndex:599,
            background:conflictColor,color:'white',border:'none',
            borderRadius:'10px 0 0 10px',padding:'14px 10px',
            cursor:'pointer',fontSize:12,fontWeight:700,
            writingMode:'vertical-rl',letterSpacing:2,
            boxShadow:'-4px 0 16px rgba(0,0,0,0.25)',
          }}>
          ◀ パネルを再表示
        </button>
      )}
      {/* サイドパネル */}
      <div style={{
        position:'fixed',top:0,right:0,bottom:0,
        width:panelW,maxWidth:'92vw',
        background:'white',
        boxShadow:'-8px 0 40px rgba(0,0,0,0.18)',
        zIndex:599,
        transform:visible&&!minimized?'translateX(0)':'translateX(100%)',
        transition:'transform 0.3s cubic-bezier(0.4,0,0.2,1)',
        display:'flex',flexDirection:'column',
        overflow:'hidden',
      }}>
        {/* ヘッダー */}
        <div style={{
          padding:'16px 18px 12px',
          background:conflictColor+'12',
          borderBottom:'1px solid '+conflictColor+'30',
          flexShrink:0,
        }}>
          <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:4}}>
            <div style={{display:'flex',alignItems:'center',gap:8}}>
              <span style={{fontSize:20}}>{hasClassConflict?'🏫':'👤'}</span>
              <div>
                <div style={{fontWeight:800,fontSize:15,color:conflictColor}}>
                  {step==='select'&&conflictTitle+'が発生します'}
                  {step==='preview'&&'配置を確認してください'}
                  {step==='done'&&'確定完了'}
                </div>
                <div style={{fontSize:10,color:'#64748B',marginTop:2,display:'flex',gap:4,flexWrap:'wrap'}}>
                  {hasClassConflict&&pill('#FEE2E2','#DC2626','学級重複')}
                  {hasTeacherConflict&&pill('#FEF3C7','#D97706','先生重複')}
                </div>
                {step==='select'&&(
                  <div style={{fontSize:10,color:'#94A3B8',marginTop:4,lineHeight:1.5}}>
                    {hasClassConflict&&<span><b style={{color:'#DC2626'}}>赤字＝重複している学級</b></span>}
                    {hasClassConflict&&hasTeacherConflict&&<span> / </span>}
                    {hasTeacherConflict&&<span><b style={{color:'#D97706'}}>橙字＝重複している先生</b></span>}
                    <span> を解消します</span>
                  </div>
                )}
              </div>
            </div>
            {step!=='done'&&(
              <div style={{display:'flex',alignItems:'center',gap:4}}>
                <button onClick={()=>setMinimized(true)}
                  title="パネルをたたんで時間割を確認"
                  style={{background:conflictColor,border:'none',cursor:'pointer',
                    color:'white',fontSize:11,fontWeight:700,borderRadius:6,
                    padding:'6px 12px',whiteSpace:'nowrap',
                    boxShadow:'0 2px 6px rgba(0,0,0,0.18)'}}>
                  👁 時間割を見る
                </button>
                <button onClick={()=>{onUndo();onClose();}}
                  style={{background:'none',border:'none',cursor:'pointer',
                    color:'#94A3B8',fontSize:20,lineHeight:1,padding:'4px'}}>×</button>
              </div>
            )}
          </div>
          {/* ステップインジケーター */}
          <div style={{display:'flex',alignItems:'center',gap:4,marginTop:8}}>
            {['select','preview','done'].map((s,i)=>(
              <React.Fragment key={s}>
                <div style={{
                  width:24,height:24,borderRadius:'50%',
                  background:step===s?conflictColor:(i<['select','preview','done'].indexOf(step)?'#22C55E':'#E2E8F0'),
                  color:step===s||i<['select','preview','done'].indexOf(step)?'white':'#94A3B8',
                  display:'flex',alignItems:'center',justifyContent:'center',
                  fontSize:11,fontWeight:700,flexShrink:0,
                  transition:'all 0.3s',
                }}>
                  {i<['select','preview','done'].indexOf(step)?'✓':(i+1)}
                </div>
                {i<2&&<div style={{flex:1,height:2,background:i<['select','preview','done'].indexOf(step)?'#22C55E':'#E2E8F0',transition:'background 0.3s'}}/>}
              </React.Fragment>
            ))}
          </div>
          <div style={{display:'flex',justifyContent:'space-between',marginTop:4}}>
            <span style={{fontSize:9,color:'#94A3B8'}}>候補選択</span>
            <span style={{fontSize:9,color:'#94A3B8'}}>確認</span>
            <span style={{fontSize:9,color:'#94A3B8'}}>確定</span>
          </div>
        </div>

        {/* ボディ（ズームスライダー fixed bottom:16 に隠れないよう paddingBottom 確保） */}
        <div style={{flex:1,overflowY:'auto',padding:'16px 18px',display:'flex',flexDirection:'column',
          paddingBottom:80}}>
          {step==='select'&&renderSelect()}
          {step==='preview'&&renderPreview()}
          {step==='done'&&renderDone()}
        </div>
      </div>
    </>
  );
}

// ── ConflictResolveModal ──────────────────────────────────────────────────────
function ConflictResolveModal({modal,classes,teachers,dateMode,onClose}){
  const{srcEntry,srcDc,tgtDc,hasClassConflict,hasTeacherConflict,conflictItems,onForce,onMoveConflict}=modal;
  const cn=id=>classes.find(c=>c.id===id)?.name||id;
  const tn=id=>teachers.find(t=>t.id===id)?.name||id;
  const DAYS7=["","月","火","水","木","金","土","日"];
  const slotLabel=(slot)=>{
    if(slot.date){
      const d=new Date(slot.date+"T00:00:00");
      return`${d.getMonth()+1}/${d.getDate()}（${["日","月","火","水","木","金","土"][d.getDay()]}）${slot.period}限`;
    }
    return`${slot.day}曜${slot.period}限`;
  };
  const entryLabel=(e)=>{
    const cls=(e.classIds||[]).map(cn).join('・');
    const tch=(e.teacherIds||[]).map(tn).join('・');
    return`${e.subject}（${cls}）${tch?tch+'先生':''}`;
  };
  const conflictColor=hasClassConflict&&hasTeacherConflict?'#7C3AED':hasClassConflict?'#DC2626':'#D97706';
  const conflictTitle=hasClassConflict&&hasTeacherConflict?'学級・先生が重複':hasClassConflict?'学級が重複':'先生が重複';
  const conflictIcon=hasClassConflict&&hasTeacherConflict?'⚠️':'学級重複'===conflictTitle?'🏫':'👤';

  return(
    <div style={{position:'fixed',inset:0,background:'rgba(15,23,42,0.65)',display:'flex',alignItems:'center',justifyContent:'center',zIndex:600}} onClick={onClose}>
      <div style={{background:'white',borderRadius:12,width:560,maxWidth:'95vw',maxHeight:'90vh',overflowY:'auto',
        boxShadow:'0 20px 60px rgba(0,0,0,0.3)'}} onClick={e=>e.stopPropagation()}>

        {/* ヘッダー */}
        <div style={{padding:'16px 20px 12px',borderBottom:'1px solid #F1F5F9',
          background:conflictColor+'10',borderRadius:'12px 12px 0 0'}}>
          <div style={{display:'flex',alignItems:'center',gap:8}}>
            <span style={{fontSize:20}}>{hasClassConflict?'🏫':'👤'}</span>
            <div>
              <div style={{fontWeight:700,fontSize:16,color:conflictColor}}>{conflictTitle}が発生します</div>
              <div style={{fontSize:11,color:'#64748B',marginTop:2}}>
                {hasClassConflict&&<span style={{background:'#FEE2E2',color:'#DC2626',borderRadius:4,padding:'1px 6px',marginRight:4,fontSize:10,fontWeight:700}}>学級重複</span>}
                {hasTeacherConflict&&<span style={{background:'#FEF3C7',color:'#D97706',borderRadius:4,padding:'1px 6px',fontSize:10,fontWeight:700}}>先生重複</span>}
                <span style={{marginLeft:6}}>重複相手を別の時限に移動するか、強制的に配置してください</span>
              </div>
            </div>
          </div>
        </div>

        <div style={{padding:'16px 20px',display:'flex',flexDirection:'column',gap:14}}>

          {/* 移動する駒の情報 */}
          <div style={{background:'#EFF6FF',borderRadius:8,padding:'10px 14px',fontSize:12}}>
            <span style={{color:'#1D4ED8',fontWeight:700}}>移動する駒：</span>
            <span style={{color:'#1E293B'}}>{entryLabel(srcEntry)}</span>
            <span style={{color:'#64748B',marginLeft:6}}><b>{slotLabel(srcDc)}</b> → <b style={{color:'#1D4ED8'}}>{slotLabel(tgtDc)}</b></span>
          </div>

          {/* 重複相手ごとの解消候補 */}
          {conflictItems.map((item,i)=>(
            <div key={item.entry.id||i} style={{border:`2px solid ${item.type==='class'?'#FCA5A5':'#FCD34D'}`,borderRadius:10,padding:'14px 16px'}}>
              <div style={{display:'flex',alignItems:'center',gap:6,marginBottom:10}}>
                <span style={{background:item.type==='class'?'#FEE2E2':'#FEF3C7',
                  color:item.type==='class'?'#DC2626':'#D97706',
                  borderRadius:4,padding:'2px 8px',fontSize:10,fontWeight:700}}>
                  {item.type==='class'?'🏫 学級重複':'👤 先生重複'}
                </span>
                <span style={{fontSize:12,color:'#1E293B',fontWeight:600}}>{entryLabel(item.entry)}</span>
                <span style={{fontSize:10,color:'#94A3B8'}}>({slotLabel({day:item.entry.day,period:item.entry.period,date:item.entry.date})})</span>
              </div>

              {item.moveCandidates.length>0?(
                <div>
                  <div style={{fontSize:10,color:'#64748B',marginBottom:6}}>📌 この駒を移動できる空きスロット：</div>
                  <div style={{display:'flex',flexWrap:'wrap',gap:6}}>
                    {item.moveCandidates.map((slot,si)=>(
                      <button key={si} onClick={()=>{
                        const conflictDc=dateMode
                          ?{date:item.entry.date,period:item.entry.period,day:item.entry.day}
                          :{day:item.entry.day,period:item.entry.period};
                        onMoveConflict(item.entry,conflictDc,slot);
                        onClose();
                      }} style={{padding:'5px 12px',background:'#F0FDF4',border:'1.5px solid #86EFAC',
                        borderRadius:6,fontSize:12,cursor:'pointer',color:'#15803D',fontWeight:600,
                        transition:'background 0.1s'}}
                        onMouseEnter={e=>e.target.style.background='#DCFCE7'}
                        onMouseLeave={e=>e.target.style.background='#F0FDF4'}>
                        ✓ {slotLabel(slot)}に移動
                      </button>
                    ))}
                  </div>
                </div>
              ):(
                <div style={{fontSize:11,color:'#94A3B8',padding:'6px 0'}}>空き時限が見つかりませんでした</div>
              )}
            </div>
          ))}

          {/* アクションボタン */}
          <div style={{display:'flex',gap:10,marginTop:4}}>
            <button onClick={()=>{onForce();onClose();}}
              style={{flex:1,padding:'10px',background:'#DC2626',color:'white',border:'none',
                borderRadius:7,cursor:'pointer',fontSize:13,fontWeight:700}}>
              ⚠ 重複のまま強制配置
            </button>
            <button onClick={onClose}
              style={{padding:'10px 20px',background:'#F1F5F9',color:'#374151',border:'none',
                borderRadius:7,cursor:'pointer',fontSize:13,fontWeight:600}}>
              キャンセル
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── EmptyClassNotice ──────────────────────────────────────────────────────────
function EmptyClassNotice({notice,classes,onClose,onJump}){
  const cls=classes.find(c=>c.id===notice.classId);
  const name=cls?.name||notice.classId;
  const d=notice.date?new Date(notice.date+"T00:00:00"):null;
  const dateStr=d?`${d.getMonth()+1}/${d.getDate()}（${["日","月","火","水","木","金","土"][d.getDay()]}）`:"";
  return(
    <div style={{position:'fixed',bottom:90,left:'50%',transform:'translateX(-50%)',
      background:'#FFFBEB',border:'2px solid #FCD34D',borderRadius:10,
      padding:'12px 18px',fontSize:13,fontWeight:700,color:'#92400E',
      boxShadow:'0 4px 20px rgba(0,0,0,0.18)',zIndex:9998,
      display:'flex',alignItems:'center',gap:12,minWidth:260}}>
      <span style={{fontSize:18}}>⚠️</span>
      <div>
        <div>{dateStr}{notice.period}限 <strong>{name}</strong> に担当先生がいなくなりました</div>
      </div>
      <button onClick={()=>onJump(notice.classId,notice.period,notice.date)}
        style={{padding:'5px 12px',background:'#D97706',color:'white',border:'none',
          borderRadius:6,cursor:'pointer',fontSize:12,fontWeight:700,whiteSpace:'nowrap'}}>
        確認する
      </button>
      <button onClick={onClose}
        style={{padding:'5px 8px',background:'none',border:'none',cursor:'pointer',
          color:'#92400E',fontSize:16,lineHeight:1}}>×</button>
    </div>
  );
}
