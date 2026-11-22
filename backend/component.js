// Lógica do componente NEXO Inteligência Política
// Classe principal que estende DCLogic (dc-runtime).
// Contém: estado, autenticação Supabase, carregamento de dados via
// frontend/services/*.js (Supabase), handlers e construtores de
// gráficos (SVG via React.createElement).
// Referenciado pelo script inline em "NEXO Politico.dc.html".
//
// Não há mais dados mockados nesta classe. Tudo vem do Supabase:
//   campaigns, intelligence_snapshots, mentions, alerts, reports,
//   monitored_entities — ver frontend/services/*.js para as queries.
// "Adversários" (anúncios de concorrentes) e "Perfis Suspeitos" não
// têm fonte de dados hoje — as telas mostram um estado "Em desenvolvimento".

const SEV_MAP = {
  critical: { label:'CRÍTICO', impactLabel:'Alto', c:'#DC2626', bg:'#FEF2F2', bd:'#FCDADA' },
  high:     { label:'ALTO',    impactLabel:'Alto', c:'#D97706', bg:'#FFFBEB', bd:'#FBE6C0' },
  medium:   { label:'MÉDIO',   impactLabel:'Médio', c:'#2563EB', bg:'#EFF4FF', bd:'#D6E2FB' },
  low:      { label:'BAIXO',   impactLabel:'Baixo', c:'#64748B', bg:'#F1F5F9', bd:'#E2E8F0' },
};

const ALERT_TYPE_LABELS = {
  strategic_risk: 'Risco Estratégico',
  crisis_detected: 'Crise Detectada',
  adversary_movement: 'Adversário',
  sentiment_critical: 'Sentimento Crítico',
  negative_trend: 'Tendência Negativa',
  theme_emerging: 'Tema Emergente',
  high_relevance: 'Alta Relevância',
  negative_sentiment: 'Sentimento Negativo',
  direct_quote: 'Citação Direta',
  opponent_mention: 'Menção a Adversário',
  critical_coverage: 'Cobertura Crítica',
};

const NEWS_SENT_MAP = { pos:{l:'Positivo',c:'#059669',bg:'#ECFDF5'}, neu:{l:'Neutro',c:'#64748B',bg:'#F1F5F9'}, neg:{l:'Negativo',c:'#DC2626',bg:'#FEF2F2'} };
const NEWS_IMP_MAP = { baixo:{l:'Baixo',c:'#64748B',bg:'#F1F5F9',bd:'#E2E8F0'}, medio:{l:'Médio',c:'#2563EB',bg:'#EFF4FF',bd:'#D6E2FB'}, alto:{l:'Alto',c:'#D97706',bg:'#FFFBEB',bd:'#FBE6C0'}, critico:{l:'Crítico',c:'#DC2626',bg:'#FEF2F2',bd:'#FCDADA'} };

class Component extends DCLogic {
  state = {
    page:'dashboard', notif:false, chat:[], draft:'', pending:false, chatError:'',
    rfilter:'semanal', newsQuery:'', newsTopic:'Todos', newsPage:0,
    session:null, authLoading:true, loginEmail:'', loginPassword:'', loginError:'', loginLoading:false,

    campaign:null, campaignError:'',
    dashLoading:true, dashError:'', snapshots:[], monitoredCount:0, criticalAlertsCount:0, adversaries:[],
    reportLoading:true, reportError:'', latestReport:null,
    newsLoading:true, newsError:'', newsAll:[],
    alertsLoading:true, alertsError:'', alertsAll:[],
    reportsLoading:true, reportsError:'', reportsAll:[],
  };
  chatRef = React.createRef();
  _keys = ['dashboard','mon','sent','ia','alert','rep','news','cfg'];
  _NEWS_PAGE_SIZE = 6;

  // Categorias fixas de filtro (taxonomia da UI, não dado de campanha).
  // O match real usa metadata.principais_temas de cada menção.
  newsTopicsData = ['Todos','Saúde','Segurança','Educação','Transporte','Emprego'];

  // Prompts de exemplo para iniciar a conversa (não são dados da campanha).
  suggestionsData = [
    'Qual é o resumo estratégico de hoje?',
    'Quais riscos a IA identificou agora?',
    'Que oportunidades estão em aberto?',
    'O que devo priorizar esta semana?',
  ];

  // Autenticação Supabase

  _sb(){ return window.NexoServices ? window.NexoServices.getClient() : null; }

  async _signIn(){
    const {loginEmail:email,loginPassword:password}=this.state;
    if(!email||!password) return;
    this.setState({loginLoading:true,loginError:''});
    const sb=this._sb();
    if(!sb){ this.setState({loginError:'Serviço indisponível, tente novamente.',loginLoading:false}); return; }
    const {error}=await sb.auth.signInWithPassword({email,password});
    if(error) this.setState({loginError:error.message,loginLoading:false});
  }

  _signOut(){
    const sb=this._sb();
    if(sb) sb.auth.signOut();
  }

  // Carregamento de dados (Supabase, via frontend/services)

  async _bootstrap(){
    if(this._bootstrapped) return;
    this._bootstrapped = true;
    try{
      const campaign = await window.NexoServices.getActiveCampaign();
      this.setState({campaign, campaignError: campaign ? '' : 'Nenhuma campanha ativa encontrada.'});
      if(!campaign) return;
      await Promise.all([
        this._loadDashboard(campaign.id),
        this._loadNews(campaign.id),
        this._loadAlerts(campaign.id),
        this._loadReports(campaign.id),
        this._loadLatestReport(campaign.id),
      ]);
    }catch(e){
      this.setState({campaignError: e?.message || 'Erro ao carregar dados da campanha.'});
    }
  }

  async _loadDashboard(campaignId){
    this.setState({dashLoading:true, dashError:''});
    try{
      const [snapshots, monitoredCount, criticalAlertsCount, adversaries] = await Promise.all([
        window.NexoServices.getSnapshotHistory(campaignId, 30),
        window.NexoServices.getMonitoredEntitiesCount(campaignId),
        window.NexoServices.getCriticalAlertsCount(campaignId),
        window.NexoServices.getAdversaries(campaignId),
      ]);
      this.setState({snapshots, monitoredCount, criticalAlertsCount, adversaries, dashLoading:false});
    }catch(e){
      this.setState({dashError: e?.message || 'Erro ao carregar indicadores.', dashLoading:false});
    }
  }

  async _loadNews(campaignId){
    this.setState({newsLoading:true, newsError:''});
    try{
      const newsAll = await window.NexoServices.getMentions(campaignId, 200);
      this.setState({newsAll, newsLoading:false});
    }catch(e){
      this.setState({newsError: e?.message || 'Erro ao carregar notícias.', newsLoading:false});
    }
  }

  async _loadAlerts(campaignId){
    this.setState({alertsLoading:true, alertsError:''});
    try{
      const alertsAll = await window.NexoServices.getAlerts(campaignId, 50);
      this.setState({alertsAll, alertsLoading:false});
    }catch(e){
      this.setState({alertsError: e?.message || 'Erro ao carregar alertas.', alertsLoading:false});
    }
  }

  async _loadReports(campaignId){
    this.setState({reportsLoading:true, reportsError:''});
    try{
      const reportsAll = await window.NexoServices.getReports(campaignId, 100);
      this.setState({reportsAll, reportsLoading:false});
    }catch(e){
      this.setState({reportsError: e?.message || 'Erro ao carregar relatórios.', reportsLoading:false});
    }
  }

  async _loadLatestReport(campaignId){
    this.setState({reportLoading:true, reportError:''});
    try{
      const latestReport = await window.NexoServices.getLatestReport(campaignId);
      this.setState({latestReport, reportLoading:false});
    }catch(e){
      this.setState({reportError: e?.message || 'Erro ao carregar relatório de inteligência.', reportLoading:false});
    }
  }

  // Formatação (apresentação apenas — nenhum cálculo de inteligência)

  _relTime(iso){
    if(!iso) return '';
    const diffMs = Date.now() - new Date(iso).getTime();
    const min = Math.round(diffMs/60000);
    if(min < 1) return 'agora';
    if(min < 60) return `há ${min} min`;
    const h = Math.round(min/60);
    if(h < 24) return `há ${h}h`;
    const d = Math.round(h/24);
    if(d === 1) return 'ontem';
    if(d < 7) return `há ${d} dias`;
    return new Date(iso).toLocaleDateString('pt-BR');
  }
  _fmtDate(iso){
    if(!iso) return '';
    return new Date(iso).toLocaleDateString('pt-BR',{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'});
  }
  _fmtDateTime(iso){
    if(!iso) return '';
    return new Date(iso).toLocaleString('pt-BR',{day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit'});
  }
  _pctChange(curr, prev){
    if(curr==null || prev==null || !prev) return null;
    return Math.round(((curr-prev)/prev)*100);
  }
  _badge(value, opts={}){
    if(value == null) return { label:'—', color:'#94A3B8', bg:'#F1F5F9' };
    const up = value >= 0;
    const arrow = up ? '▲ ' : '▼ ';
    const suffix = opts.suffix || '';
    return { label: arrow + Math.abs(value) + suffix, color: up?'#059669':'#DC2626', bg: up?'#ECFDF5':'#FEF2F2' };
  }

  // Construtores de gráficos SVG

  buildSpark(vals, color, w=96, h=30){
    const H = React.createElement;
    const clean = (vals||[]).map(v=>Number(v)||0);
    if(clean.length < 2){
      return H('svg',{viewBox:`0 0 ${w} ${h}`,width:'100%',height:h}, []);
    }
    const max = Math.max(...clean), min = Math.min(...clean), rng = (max-min)||1;
    const pts = clean.map((v,i)=>[ +(i*(w/(clean.length-1))).toFixed(1), +(h-3-((v-min)/rng)*(h-6)).toFixed(1) ]);
    const line = 'M'+pts.map(p=>p[0]+' '+p[1]).join(' L');
    const area = line+` L${w} ${h} L0 ${h} Z`;
    const id = 'sp'+Math.round(clean.reduce((a,b)=>a+b,0))+color.slice(1);
    return H('svg',{viewBox:`0 0 ${w} ${h}`,width:'100%',height:h,preserveAspectRatio:'none',style:{display:'block',overflow:'visible'}},[
      H('defs',{key:'d'}, H('linearGradient',{id,x1:0,y1:0,x2:0,y2:1},[
        H('stop',{key:0,offset:'0%',stopColor:color,stopOpacity:.16}),
        H('stop',{key:1,offset:'100%',stopColor:color,stopOpacity:0}) ])),
      H('path',{key:'a',d:area,fill:`url(#${id})`}),
      H('path',{key:'l',d:line,fill:'none',stroke:color,strokeWidth:1.8,strokeLinecap:'round',strokeLinejoin:'round',vectorEffect:'non-scaling-stroke'}),
    ]);
  }

  buildSentiment(series, labels){
    const H = React.createElement;
    const pos = series?.pos||[], neu = series?.neu||[], neg = series?.neg||[];
    const n = pos.length;
    const W=820,Ht=300,L=10,R=14,T=16,B=30;
    if(n < 2){
      return H('svg',{viewBox:`0 0 ${W} ${Ht}`,width:'100%',style:{display:'block'}}, [
        H('text',{key:'e',x:W/2,y:Ht/2,textAnchor:'middle',style:{font:'500 13px Switzer,sans-serif',fill:'#94A3B8'}},'Ainda não há histórico suficiente para este gráfico.')
      ]);
    }
    const X=i=> L + i*(W-L-R)/(n-1);
    const Y=v=> T + (100-v)/100*(Ht-T-B);
    const path = a => 'M'+a.map((v,i)=>X(i).toFixed(1)+' '+Y(v).toFixed(1)).join(' L');
    const areaPath = a => path(a)+` L${X(n-1).toFixed(1)} ${Ht-B} L${X(0).toFixed(1)} ${Ht-B} Z`;
    const grid=[0,25,50,75,100].map((g,i)=>[
      H('line',{key:'g'+i,x1:L,x2:W-R,y1:Y(g),y2:Y(g),stroke:'#EEF1F5',strokeWidth:1}),
      H('text',{key:'gt'+i,x:0,y:Y(g)-4,style:{font:'500 11px Switzer,sans-serif',fill:'#9AA3AF'}}, g+'%'),
    ]);
    const tickIdx = Array.from(new Set([0, Math.round((n-1)*0.2), Math.round((n-1)*0.4), Math.round((n-1)*0.6), Math.round((n-1)*0.8), n-1]));
    const xlabels = tickIdx.map((i,k)=> H('text',{key:'x'+k,x:X(i),y:Ht-8,textAnchor:'middle',style:{font:'500 11px Switzer,sans-serif',fill:'#9AA3AF'}}, (labels && labels[i]) || ''));
    const seriesDef=[ {a:pos,c:'#059669',fill:true}, {a:neu,c:'#94A3B8'}, {a:neg,c:'#DC2626'} ];
    const els=[];
    els.push(H('defs',{key:'def'}, H('linearGradient',{id:'sgrad',x1:0,y1:0,x2:0,y2:1},[
      H('stop',{key:0,offset:'0%',stopColor:'#059669',stopOpacity:.14}),
      H('stop',{key:1,offset:'100%',stopColor:'#059669',stopOpacity:0}) ])));
    els.push(...grid.flat());
    els.push(...xlabels);
    seriesDef.forEach((ser,i)=>{
      if(ser.fill) els.push(H('path',{key:'f'+i,d:areaPath(ser.a),fill:'url(#sgrad)'}));
      els.push(H('path',{key:'p'+i,d:path(ser.a),fill:'none',stroke:ser.c,strokeWidth:2.4,strokeLinecap:'round',strokeLinejoin:'round'}));
      els.push(H('circle',{key:'c'+i,cx:X(n-1),cy:Y(ser.a[n-1]),r:3.4,fill:'#fff',stroke:ser.c,strokeWidth:2}));
    });
    return H('svg',{viewBox:`0 0 ${W} ${Ht}`,width:'100%',style:{display:'block'}}, els);
  }

  buildDonut(segments){
    const H = React.createElement;
    const total = (segments||[]).reduce((s,d)=>s+(d.v||0),0);
    if(!total){
      return H('svg',{viewBox:'0 0 200 200',width:'100%',style:{maxWidth:'210px',display:'block'}},[
        H('circle',{key:'bg',cx:100,cy:100,r:86,fill:'none',stroke:'#F1F5F9',strokeWidth:30}),
        H('text',{key:'t1',x:100,y:104,textAnchor:'middle',style:{font:'600 15px "General Sans",Switzer,sans-serif',fill:'#94A3B8'}},'Sem dados'),
      ]);
    }
    let a=-Math.PI/2; const R=86,r=56,cx=100,cy=100, gap=0.03;
    const arcs=segments.map((d,i)=>{
      const ang=Math.max(d.v,0)/100*Math.PI*2;
      const a1=a+gap/2, a2=a+ang-gap/2; a+=ang;
      const large=(a2-a1)>Math.PI?1:0;
      const p=`M${(cx+R*Math.cos(a1)).toFixed(2)} ${(cy+R*Math.sin(a1)).toFixed(2)} A${R} ${R} 0 ${large} 1 ${(cx+R*Math.cos(a2)).toFixed(2)} ${(cy+R*Math.sin(a2)).toFixed(2)} L${(cx+r*Math.cos(a2)).toFixed(2)} ${(cy+r*Math.sin(a2)).toFixed(2)} A${r} ${r} 0 ${large} 0 ${(cx+r*Math.cos(a1)).toFixed(2)} ${(cy+r*Math.sin(a1)).toFixed(2)} Z`;
      return H('path',{key:i,d:p,fill:d.c});
    });
    const dominant = segments.reduce((m,d)=> d.v>m.v?d:m, segments[0]);
    return H('svg',{viewBox:'0 0 200 200',width:'100%',style:{maxWidth:'210px',display:'block'}},[
      ...arcs,
      H('text',{key:'t1',x:100,y:97,textAnchor:'middle',style:{font:'600 32px "General Sans",Switzer,sans-serif',fill:'#0F172A'}},dominant.v+'%'),
      H('text',{key:'t2',x:100,y:120,textAnchor:'middle',style:{font:'600 11px Switzer,sans-serif',fill:'#64748B',letterSpacing:'.08em'}},(dominant.l||'').toUpperCase()),
    ]);
  }

  // Converte "*texto*" em negrito preto dentro das mensagens do chat.
  formatChatText(text){
    const H = React.createElement;
    if(!text) return text;
    return text.split(/\*(.+?)\*/g).map((part,i)=>
      i % 2 === 1 ? H('strong',{key:i, style:{fontWeight:700,color:'#000'}}, part) : part
    );
  }

  // Handlers de eventos e lógica de UI

  async send(text){
    const t = (text!=null?text:this.state.draft).trim();
    if(!t || this.state.pending) return;
    this.setState(s=>({ chat:[...s.chat,{role:'user',text:t}], draft:'', pending:true, chatError:'' }));
    try{
      const campaignId = this.state.campaign?.id;
      const userId = this.state.session?.user?.id;
      const res = await window.NexoServices.postChatMessage({ message:t, campaignId, userId });
      this.setState(s=>({ chat:[...s.chat,{role:'ai',text:res.answer}], pending:false }));
    }catch(e){
      const msg = e?.message || 'Não foi possível falar com o NEXO agora.';
      this.setState(s=>({ chat:[...s.chat,{role:'ai',text:'⚠️ '+msg}], pending:false, chatError:msg }));
    }
  }

  // Ciclo de vida

  componentDidMount(){
    const tryInit=()=>{
      if(!window.supabase){ setTimeout(tryInit,100); return; }
      const sb=this._sb();
      if(!sb) return;
      sb.auth.getSession().then(({data:{session}})=>{
        this.setState({session,authLoading:false});
        if(session) this._bootstrap();
      });
      this._authSub=sb.auth.onAuthStateChange((_e,session)=>{
        this.setState({session,authLoading:false});
        if(session) this._bootstrap();
      });
    };
    tryInit();
  }
  componentDidUpdate(){ const el=this.chatRef.current; if(el) el.scrollTop=el.scrollHeight; }
  componentWillUnmount(){ this._authSub?.data?.subscription?.unsubscribe?.(); }

  // Helpers de renderização por página

  newsVals(){
    const q = this.state.newsQuery.toLowerCase().trim();
    const topic = this.state.newsTopic;
    const filtered = this.state.newsAll.filter(n=>
      (topic==='Todos' || (n.temas||[]).some(t=>String(t).toLowerCase().includes(topic.toLowerCase()))) &&
      (!q || n.title.toLowerCase().includes(q) || n.source.toLowerCase().includes(q))
    );
    const pageSize = this._NEWS_PAGE_SIZE;
    const totalPages = Math.max(1, Math.ceil(filtered.length/pageSize));
    const page = Math.min(this.state.newsPage, totalPages-1);
    const pageItems = filtered.slice(page*pageSize, page*pageSize+pageSize).map(n=>({
      ...n,
      sentL:NEWS_SENT_MAP[n.sent].l, sentC:NEWS_SENT_MAP[n.sent].c, sentBg:NEWS_SENT_MAP[n.sent].bg,
      impL:NEWS_IMP_MAP[n.imp].l, impC:NEWS_IMP_MAP[n.imp].c, impBg:NEWS_IMP_MAP[n.imp].bg, impBd:NEWS_IMP_MAP[n.imp].bd,
      date:this._fmtDate(n.date), topic:(n.temas&&n.temas[0])||'Geral', reach:n.reach||'—',
      hasUrl: !!n.url,
    }));
    const newsTopics=this.newsTopicsData.map(t=>({ l:t,
      click:()=>this.setState({newsTopic:t, newsPage:0}),
      bg: topic===t?'#0F172A':'#fff', fg: topic===t?'#fff':'#475569', bd: topic===t?'#0F172A':'#E6EAEF' }));
    return {
      newsQuery:this.state.newsQuery,
      onNewsSearch:(e)=>this.setState({newsQuery:e.target.value, newsPage:0}),
      newsTopics, filteredNews:pageItems, noNews:filtered.length===0,
      newsLoading:this.state.newsLoading, newsError:this.state.newsError,
      newsHasPrev: page>0, newsHasNext: page<totalPages-1,
      newsPageLabel: `Página ${page+1} de ${totalPages}`,
      onNewsPrev:()=>this.setState(s=>({newsPage:Math.max(0,s.newsPage-1)})),
      onNewsNext:()=>this.setState(s=>({newsPage:Math.min(totalPages-1,s.newsPage+1)})),
    };
  }

  alertsVals(){
    const alerts = this.state.alertsAll.map(a=>{
      const sevInfo = SEV_MAP[(a.severity||'medium').toLowerCase()] || SEV_MAP.medium;
      return {
        sev: sevInfo.label, sc: sevInfo.c, sbg: sevInfo.bg, sbd: sevInfo.bd,
        title: a.title, impact: sevInfo.impactLabel,
        rec: a.description || 'Sem descrição registrada para este alerta.',
        time: this._relTime(a.created_at),
        ch: ALERT_TYPE_LABELS[a.type] || 'Monitoramento',
      };
    });
    return { alerts, noAlerts:alerts.length===0, alertsLoading:this.state.alertsLoading, alertsError:this.state.alertsError };
  }

  reportsVals(){
    const rfilter = this.state.rfilter;
    const windowMs = { diario:24*3600*1000, semanal:7*24*3600*1000, mensal:30*24*3600*1000 }[rfilter];
    const now = Date.now();
    const filtered = this.state.reportsAll.filter(r => (now - new Date(r.created_at).getTime()) <= windowMs);
    const reportTabs=[{k:'diario',l:'Diário'},{k:'semanal',l:'Semanal'},{k:'mensal',l:'Mensal'}].map(t=>({
      ...t, click:()=>this.setState({rfilter:t.k}),
      style:{padding:'7px 16px',borderRadius:'8px',fontSize:'13px',fontWeight:600,cursor:'pointer',border:'none',fontFamily:'inherit',transition:'all .14s',
        background: rfilter===t.k?'#0F172A':'transparent', color: rfilter===t.k?'#fff':'#64748B'},
    }));
    const filteredReports = filtered.map(r=>({ t:r.title, d:this._fmtDateTime(r.created_at), status:'Pronto' }));
    return { reportTabs, filteredReports, rfilter, noReports:filteredReports.length===0,
      reportsLoading:this.state.reportsLoading, reportsError:this.state.reportsError };
  }

  monVals(){
    const palette = ['#2563EB','#059669','#D97706','#6366F1','#DC2626','#0891B2','#7C3AED','#DB2777','#0F172A'];
    const adversaries = this.state.adversaries.map((a,i)=>{
      const parts = a.name.trim().split(/\s+/);
      const initials = parts.length>=2 ? (parts[0][0]+parts[1][0]) : a.name.slice(0,2);
      const total = a.mentions||0;
      const pct = n => total ? Math.round(n/total*100) : 0;
      return {
        name: a.name,
        initials: (initials || a.name.slice(0,2)).toUpperCase(),
        color: palette[i % palette.length],
        mentions: total,
        hasMentions: total>0,
        posPct: pct(a.positive), neuPct: pct(a.neutral), negPct: pct(a.negative),
        pos: a.positive, neu: a.neutral, neg: a.negative,
      };
    });
    return {
      adversaries,
      noAdversaries: adversaries.length===0,
      adversariesLoading: this.state.dashLoading,
      adversariesError: this.state.dashError,
    };
  }

  dashboardVals(){
    const snaps = this.state.snapshots;
    const latest = snaps.length ? snaps[snaps.length-1] : null;
    const prev = snaps.length>1 ? snaps[snaps.length-2] : null;

    const sentPct = latest ? latest.popularity_score : null;
    const sentDelta = (latest && prev!=null) ? latest.popularity_score - prev.popularity_score : null;
    const mentionsCount = latest ? latest.total_mentions : null;
    const mentionsDeltaPct = (latest && prev) ? this._pctChange(latest.total_mentions, prev.total_mentions) : null;
    const presenceScore = latest ? latest.overall_score : null;
    const presenceDeltaPct = (latest && prev) ? this._pctChange(latest.overall_score, prev.overall_score) : null;

    const themes = latest ? (window.NexoServices.parseMaybeJSON(latest.top_themes, []) || []) : [];
    const maxCount = Math.max(1, ...themes.map(t=>t.count||0));
    const topThemesBars = themes.slice(0,5).map(t=>({
      label: t.tema || t.theme || '—', count: t.count||0,
      pct: Math.round(((t.count||0)/maxCount)*100),
    }));
    const wordCloudPalette = ['#0F172A','#2563EB','#059669','#D97706','#6366F1','#DC2626'];
    const wordCloud = themes.slice(0,15).map((t,i)=>({
      label: t.tema || t.theme || '—',
      size: 14 + Math.round(((t.count||0)/maxCount)*28),
      color: wordCloudPalette[i % wordCloudPalette.length],
    }));

    const total = latest ? (latest.sentiment_positive+latest.sentiment_neutral+latest.sentiment_negative) : 0;
    const posPct = total ? Math.round(latest.sentiment_positive/total*100) : 0;
    const neuPct = total ? Math.round(latest.sentiment_neutral/total*100) : 0;
    const negPct = total ? Math.round(latest.sentiment_negative/total*100) : 0;
    const dominantSentLabel = posPct>=neuPct && posPct>=negPct ? 'positivo' : (neuPct>=negPct ? 'neutro' : 'negativo');

    const snapLabels = snaps.map(s=> new Date(s.created_at).toLocaleDateString('pt-BR',{day:'2-digit',month:'2-digit'}));
    const sentimentSeries = { pos: [], neu: [], neg: [] };
    snaps.forEach(s=>{
      const t = s.sentiment_positive+s.sentiment_neutral+s.sentiment_negative;
      sentimentSeries.pos.push(t?Math.round(s.sentiment_positive/t*100):0);
      sentimentSeries.neu.push(t?Math.round(s.sentiment_neutral/t*100):0);
      sentimentSeries.neg.push(t?Math.round(s.sentiment_negative/t*100):0);
    });

    const content = this.state.latestReport ? this.state.latestReport.content : null;
    const insights = (content && Array.isArray(content.insights))
      ? content.insights.map(txt=>({txt, tag:'Insight', c:'#2563EB', bg:'#EFF4FF'}))
      : [];
    const reportSummary = content?.summary || 'Ainda não há relatório gerado para esta campanha.';
    const reportGeneratedLabel = this.state.latestReport ? this._relTime(this.state.latestReport.created_at) : '';

    return {
      dashLoading:this.state.dashLoading, dashError:this.state.dashError,
      reportLoading:this.state.reportLoading, reportError:this.state.reportError,
      hasSnapshots: snaps.length>0,
      sentPct: sentPct ?? 0, sentBadge:this._badge(sentDelta,{suffix:' pts'}),
      mentionsCount: mentionsCount ?? 0, mentionsBadge:this._badge(mentionsDeltaPct,{suffix:'%'}),
      presenceScore: presenceScore ?? 0, presenceBadge:this._badge(presenceDeltaPct,{suffix:'%'}),
      criticalAlertsCount:this.state.criticalAlertsCount, monitoredCount:this.state.monitoredCount,
      topThemesBars, noThemes: topThemesBars.length===0,
      wordCloud, noWordCloud: wordCloud.length===0,
      donut: this.buildDonut([{v:posPct,c:'#059669',l:'Positivo'},{v:neuPct,c:'#94A3B8',l:'Neutro'},{v:negPct,c:'#DC2626',l:'Negativo'}]),
      sentPosPct:posPct, sentNeuPct:neuPct, sentNegPct:negPct, dominantSentLabel,
      sentimentChart:this.buildSentiment(sentimentSeries, snapLabels),
      sparkSent:this.buildSpark(snaps.map(s=>s.popularity_score), '#059669'),
      sparkMent:this.buildSpark(snaps.map(s=>s.total_mentions), '#2563EB'),
      sparkGrow:this.buildSpark(snaps.map(s=>s.overall_score), '#059669'),
      insights, noInsights: insights.length===0,
      reportSummary, reportGeneratedLabel, reportInsightsSide: insights.slice(0,3),
    };
  }

  // renderVals: contrato entre back-end e template front-end

  renderVals(){
    const page=this.state.page;
    const session=this.state.session;
    const isLoggedIn=!!session&&!this.state.authLoading;
    const isLoggedOut=!session&&!this.state.authLoading;
    const isAuthLoading=this.state.authLoading;
    const titles={dashboard:'Visão Geral',mon:'Monitoramento',sent:'Análise de Sentimento',ia:'IA Estratégica',alert:'Central de Alertas',rep:'Relatórios',news:'Notícias',cfg:'Configurações'};
    const nav={}, go={};
    this._keys.forEach(k=>{
      const active = page===k;
      nav[k]={ bg: active?'#EFF4FF':'transparent', color: active?'#2563EB':'#475569', weight: active?600:500 };
      go[k]=()=>this.setState({page:k,notif:false});
    });

    const suggestions=this.suggestionsData.map(s=>({text:s, click:()=>this.send(s)}));

    return {
      page,
      isLoggedIn, isLoggedOut, isAuthLoading,
      loginEmail:this.state.loginEmail,
      loginPassword:this.state.loginPassword,
      loginError:this.state.loginError,
      loginBtnLabel:this.state.loginLoading?'Entrando…':'Entrar',
      onLoginEmail:(e)=>this.setState({loginEmail:e.target.value}),
      onLoginPassword:(e)=>this.setState({loginPassword:e.target.value}),
      onLoginKey:(e)=>{ if(e.key==='Enter') this._signIn(); },
      onLogin:()=>this._signIn(),
      onSignOut:()=>this._signOut(),
      userEmail:session?.user?.email??'admin@nexo.com',
      userInitials:session?.user?.email?session.user.email.slice(0,2).toUpperCase():'AG',
      isDashboard:page==='dashboard', isMon:page==='mon', isSent:page==='sent',
      isIA:page==='ia', isAlert:page==='alert', isRep:page==='rep', isCfg:page==='cfg',
      isNews:page==='news',
      ...this.newsVals(), ...this.alertsVals(), ...this.reportsVals(), ...this.monVals(), ...this.dashboardVals(),
      pageTitle:titles[page],
      today:new Date().toLocaleDateString('pt-BR',{weekday:'long',day:'2-digit',month:'long',year:'numeric'}),
      politician:this.props.politicianName ?? this.state.campaign?.candidate_name ?? 'Ricardo Lima',
      cargo:this.props.cargo ?? 'Pré-candidato a Prefeito',
      initials:'AG',
      nav, go,
      navHover:{background:'#F1F5F9'},
      notif:this.state.notif,
      notifs:this.state.alertsAll.slice(0,4).map(a=>({
        t:a.title, s:this._relTime(a.created_at),
        c:(SEV_MAP[(a.severity||'medium').toLowerCase()]||SEV_MAP.medium).c,
      })),
      toggleNotif:()=>this.setState(s=>({notif:!s.notif})),
      chat:this.state.chat.map(m=>({ ...(m.role==='user'
        ? {...m, bg:'#0F172A', label:'Você', badge:this.props.politicianName==='Ricardo Lima'||!this.props.politicianName?'AG':'Eu'}
        : {...m, bg:'linear-gradient(135deg,#2563EB,#1E40AF)', label:'NEXO', badge:'NX'}), renderedText:this.formatChatText(m.text) })),
      draft:this.state.draft, pending:this.state.pending, chatError:this.state.chatError,
      hasChat:this.state.chat.length>0, isEmptyChat:this.state.chat.length===0 && !this.state.pending, suggestions,
      chatRef:this.chatRef,
      onDraft:(e)=>this.setState({draft:e.target.value}),
      onKey:(e)=>{ if(e.key==='Enter' && !e.shiftKey){ e.preventDefault(); this.send(); } },
      onSend:()=>this.send(),
    };
  }
}
