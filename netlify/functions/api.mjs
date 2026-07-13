import { randomUUID } from 'node:crypto'

const ERROR_CODES = {
  MISSING_API_KEY: 'missing_api_key', INVALID_REQUEST: 'invalid_request',
  INSUFFICIENT_CREDITS: 'insufficient_credits', PROVIDER_UNAVAILABLE: 'provider_unavailable',
}
const PRICING = { 'chat.completions': 3, 'writing.rewrite': 5, 'writing.draft': 10, 'coding.explain': 10, 'coding.review': 20, 'coding.write': 20 }

function makeRequestId() { return `tera_req_${randomUUID().replace(/-/g, '').slice(0, 16)}` }
function makeError(code, message, requestId) { const e = { error: { code, message } }; if (requestId) e.error.requestId = requestId; return e }
function extractApiKey(headers) {
  const a = headers['authorization'] || headers['Authorization'] || '';
  if (a.startsWith('Bearer ')) return a.slice(7).trim();
  return headers['x-api-key'] || headers['X-Api-Key'] || null
}

async function callProvider(system, user) {
  const key = process.env.MISTRAL_API_KEY;
  if (!key) return '{"text":"Mock: Set MISTRAL_API_KEY"}';
  const r = await fetch('https://api.mistral.ai/v1/chat/completions', {
    method:'POST', headers:{'Content-Type':'application/json',Authorization:`Bearer ${key}`},
    body: JSON.stringify({
      model: process.env.TERA_API_MODEL||'mistral-small-latest',
      messages:[{role:'system',content:system},{role:'user',content:user}],
      temperature:0.3, max_tokens:4000
    })
  });
  if (!r.ok) throw new Error(`Provider ${r.status}`);
  const d = await r.json();
  const c = d.choices?.[0]?.message?.content;
  if (typeof c === 'string') return c.trim();
  throw new Error('Empty response');
}

async function callProviderChat(input) {
  const key = process.env.MISTRAL_API_KEY;
  if (!key) return { model: input.model, choices: [{ index:0, message:{role:'assistant',content:`Mock: ${(input.messages?.slice(-1)[0]?.content||'').slice(0,100)}...`}, finish_reason:'stop' }], usage: { prompt_tokens:10, completion_tokens:10, total_tokens:20 } };
  const r = await fetch('https://api.mistral.ai/v1/chat/completions', {
    method:'POST', headers:{'Content-Type':'application/json',Authorization:`Bearer ${key}`},
    body: JSON.stringify({ model: input.model||process.env.TERA_API_MODEL||'mistral-small-latest', messages: input.messages, max_tokens: input.max_tokens??2000, temperature: input.temperature??0.7 })
  });
  if (!r.ok) throw new Error(`Provider ${r.status}`);
  const d = await r.json();
  const choices = (d.choices||[]).map(c => ({ index: c.index??0, message: { role: c.message?.role??'assistant', content: (c.message?.content||'').trim() }, finish_reason: c.finish_reason??'stop' }));
  if (!choices.length) throw new Error('Empty response');
  return { model: input.model, choices, usage: { prompt_tokens: d.usage?.prompt_tokens??0, completion_tokens: d.usage?.completion_tokens??0, total_tokens: d.usage?.total_tokens??0 } };
}

function tryParseJson(text) { const m = text.match(/\{[\s\S]*\}/); if (!m) return null; try { return JSON.parse(m[0]) } catch { return null } }
async function execRewrite(input) { const raw = await callProvider('Return ONLY JSON: {"text":"","notes":[]}', JSON.stringify({task:'rewrite',...input})); const p = tryParseJson(raw); if (p?.text) return {text:p.text,notes:Array.isArray(p.notes)?p.notes.filter(n=>typeof n==='string'):[]}; return {text:raw,notes:[]} }
async function execDraft(input) { const raw = await callProvider('Return ONLY JSON: {"text":"","title":null}', JSON.stringify({task:'draft',...input})); const p = tryParseJson(raw); if (p?.text) return {text:p.text,title:typeof p.title==='string'?p.title:null}; return {text:raw,title:null} }
async function execExplain(input) { const raw = await callProvider('Return ONLY JSON: {"summary":"","explanation":"","importantLines":[],"risks":[]}', JSON.stringify(input)); const p = tryParseJson(raw); if (p?.summary) return {summary:p.summary,explanation:p.explanation||'',importantLines:Array.isArray(p.importantLines)?p.importantLines.filter(l=>typeof l==='object'):[],risks:Array.isArray(p.risks)?p.risks.filter(r=>typeof r==='string'):[]}; return {summary:'Generated.',explanation:raw,importantLines:[],risks:[]} }
async function execReview(input) { const raw = await callProvider('Return ONLY JSON: {"summary":"","issues":[],"improvedCode":null}', JSON.stringify(input)); const p = tryParseJson(raw); if (p?.summary) return {summary:p.summary,issues:Array.isArray(p.issues)?p.issues.filter(i=>typeof i==='object'):[],improvedCode:typeof p.improvedCode==='string'?p.improvedCode:null}; return {summary:'Completed.',issues:[],improvedCode:null} }
async function execWrite(input) { const raw = await callProvider('Return ONLY JSON: {"code":"","explanation":"","language":"","files":[],"testCode":null}', JSON.stringify(input)); const p = tryParseJson(raw); if (p?.code) return {code:p.code,explanation:p.explanation||'',language:p.language||input.language,files:Array.isArray(p.files)?p.files.filter(f=>typeof f==='object'):[{name:`main.${input.language}`,code:p.code}],testCode:typeof p.testCode==='string'?p.testCode:null}; return {code:raw,explanation:'Generated.',language:input.language,files:[{name:`main.${input.language}`,code:raw}],testCode:null} }
async function execChat(data) { return callProviderChat({model:data.model,messages:data.messages,max_tokens:data.max_tokens,temperature:data.temperature}) }

async function handler(event) {
  const method = event.httpMethod||'GET', path = event.path||'/', headers = event.headers||{}
  const body = event.body ? (event.isBase64Encoded ? Buffer.from(event.body,'base64').toString('utf-8') : event.body) : null
  const rid = makeRequestId()

  // GET routes
  if (method === 'GET') {
    if (path === '/v1/tera/health' || path === '/health') return { statusCode:200, headers:{'Content-Type':'application/json'}, body:JSON.stringify({status:'ok',version:'0.1.0',requestId:rid}) }
    if (path === '/v1/tera/capabilities') return { statusCode:200, headers:{'Content-Type':'application/json'}, body:JSON.stringify({capabilities:[
      {id:'chat.completions',name:'Chat Completions',credits:3},{id:'writing.rewrite',name:'Rewrite Text',credits:5},
      {id:'writing.draft',name:'Draft Content',credits:10},{id:'coding.explain',name:'Explain Code',credits:10},
      {id:'coding.review',name:'Review Code',credits:20},{id:'coding.write',name:'Write Code',credits:20},
    ],requestId:rid}) }
    if (path === '/v1/tera/pricing') return { statusCode:200, headers:{'Content-Type':'application/json'}, body:JSON.stringify({pricing:PRICING,requestId:rid}) }
    // Product namespace health/pricing
    const nsMatch = path.match(/^\/v1\/(skills|searchlane|geolane|agent-browser|invoicelane)\/(health|pricing)$/)
    if (nsMatch) {
      const ns = nsMatch[1]
      if (nsMatch[2] === 'health') return { statusCode:200, headers:{'Content-Type':'application/json'}, body:JSON.stringify({status:'ok',service:`${ns}-api`,version:'0.1.0',requestId:rid,proxied:true,timestamp:new Date().toISOString()}) }
      const pricingMap = { skills:{'generate.github-profile':80,'generate.github-repo':100,'generate.docs':100,'generate.text':40,'export.cursor':10,'export.claude':10}, searchlane:{query:5,news:8,research:30}, geolane:{audit:40,compare:50}, 'agent-browser':{check:5,screenshot:8,evidence:10,extract:10,analyze:15}, invoicelane:{extract:20,validate:10} }
      return { statusCode:200, headers:{'Content-Type':'application/json'}, body:JSON.stringify({pricing:pricingMap[ns]||{},requestId:rid}) }
    }
    return { statusCode:404, headers:{'Content-Type':'application/json'}, body:JSON.stringify({error:{code:'not_found',message:'Not found',requestId:rid}}) }
  }

  if (method !== 'POST') return { statusCode:404, headers:{'Content-Type':'application/json'}, body:JSON.stringify({error:{code:'not_found',message:'Not found'}}) }

  const apiKey = extractApiKey(headers)
  if (!apiKey) return { statusCode:401, headers:{'Content-Type':'application/json'}, body:JSON.stringify(makeError(ERROR_CODES.MISSING_API_KEY,'API key required')) }

  let data
  try { data = typeof body === 'string' ? JSON.parse(body) : body } catch { return { statusCode:400, headers:{'Content-Type':'application/json'}, body:JSON.stringify(makeError(ERROR_CODES.INVALID_REQUEST,'Invalid JSON',rid)) } }

  const routes = {
    '/v1/tera/chat/completions': { action:'chat.completions', cr:3, exec: async d => {
      if (!Array.isArray(d.messages)||!d.messages.length) return {s:400,b:makeError(ERROR_CODES.INVALID_REQUEST,'messages required',rid)}
      return {s:200,b:{id:rid,object:'chat.completion',result:await execChat(d),usage:{credits:3,action:'chat.completions'}}}
    }},
    '/v1/tera/writing/rewrite': { action:'writing.rewrite', cr:5, exec: async d => { if (!d.text) return {s:400,b:makeError(ERROR_CODES.INVALID_REQUEST,'text required',rid)}; return {s:200,b:{id:rid,object:'writing.rewrite',result:await execRewrite(d),usage:{credits:5,action:'writing.rewrite'}}} }},
    '/v1/tera/writing/draft': { action:'writing.draft', cr:10, exec: async d => { const t=['email','social_post','article','lesson_note','announcement']; if (!d.type||!t.includes(d.type)) return {s:400,b:makeError(ERROR_CODES.INVALID_REQUEST,'type must be one of: '+t.join(', '),rid)}; if (!d.brief) return {s:400,b:makeError(ERROR_CODES.INVALID_REQUEST,'brief required',rid)}; return {s:200,b:{id:rid,object:'writing.draft',result:await execDraft(d),usage:{credits:10,action:'writing.draft'}}} }},
    '/v1/tera/coding/explain': { action:'coding.explain', cr:10, exec: async d => { if (!d.language||!d.code) return {s:400,b:makeError(ERROR_CODES.INVALID_REQUEST,'language and code required',rid)}; return {s:200,b:{id:rid,object:'coding.explain',result:await execExplain(d),usage:{credits:10,action:'coding.explain'}}} }},
    '/v1/tera/coding/review': { action:'coding.review', cr:20, exec: async d => { if (!d.language||!d.code) return {s:400,b:makeError(ERROR_CODES.INVALID_REQUEST,'language and code required',rid)}; return {s:200,b:{id:rid,object:'coding.review',result:await execReview(d),usage:{credits:20,action:'coding.review'}}} }},
    '/v1/tera/coding/write': { action:'coding.write', cr:20, exec: async d => { if (!d.language||!d.task) return {s:400,b:makeError(ERROR_CODES.INVALID_REQUEST,'language and task required',rid)}; return {s:200,b:{id:rid,object:'coding.write',result:await execWrite(d),usage:{credits:20,action:'coding.write'}}} }},
  }

  const route = routes[path]
  if (!route) {
    // ── Product routes beyond Tera ──────────────────────────────
    const prodRoutes = {
      // Skills
      'POST /v1/skills/generate/github-profile': { cr:80, exec: async d => { return { data: { status:'generated', skill: { name: (d.input||'custom-skill'), credits:80 }, message: 'Skills endpoint ready. AI backend not connected.' } } } },
      'POST /v1/skills/export/cursor': { cr:10, exec: async d => { return { data: { status:'exported', format:'cursor', compatibleWith:['Cursor'] } } } },
      'POST /v1/skills/export/claude': { cr:10, exec: async d => { return { data: { status:'exported', format:'claude', compatibleWith:['Claude Code'] } } } },
      // SearchLane
      'POST /v1/searchlane/query': { cr:5, exec: async d => { return { data: { results: [], query: d.query||'', status:'endpoint_defined', message: 'SearchLane query endpoint ready. Search provider not connected.' } } } },
      'POST /v1/searchlane/news': { cr:8, exec: async d => { return { data: { results: [], query: d.query||'', status:'endpoint_defined' } } } },
      'POST /v1/searchlane/research': { cr:30, exec: async d => { return { data: { results: [], topic: d.topic||'', status:'endpoint_defined' } } } },
      // GeoLane
      'POST /v1/geolane/audit': { cr:40, exec: async d => { return { data: { status:'endpoint_defined', url: d.url||'' } } } },
      'POST /v1/geolane/compare': { cr:50, exec: async d => { return { data: { status:'endpoint_defined', urls: (d.urls||[]) } } } },
      // Agent Browser
      'POST /v1/agent-browser/check': { cr:5, exec: async d => { return { data: { status:'endpoint_defined', url: d.url||'' } } } },
      'POST /v1/agent-browser/screenshot': { cr:8, exec: async d => { return { data: { status:'endpoint_defined', url: d.url||'' } } } },
      'POST /v1/agent-browser/evidence': { cr:10, exec: async d => { return { data: { status:'endpoint_defined' } } } },
      'POST /v1/agent-browser/extract': { cr:10, exec: async d => { return { data: { status:'endpoint_defined' } } } },
      'POST /v1/agent-browser/analyze': { cr:15, exec: async d => { return { data: { status:'endpoint_defined' } } } },
      // InvoiceLane
      'POST /v1/invoicelane/extract': { cr:20, exec: async d => { return { data: { status:'endpoint_defined', message: 'InvoiceLane endpoint ready. Document extraction not connected.' } } } },
      'POST /v1/invoicelane/validate': { cr:10, exec: async d => { return { data: { status:'endpoint_defined' } } } },
      // MCP
      'POST /mcp': { cr:0, exec: async d => { return { data: { mcp: { serverInfo:{name:'tera-api-mcp',version:'0.1.0'}, tools:[] }, message: 'MCP endpoint ready.' } } } },
    }
    const kr = `${method} ${path}`
    const prodRoute = prodRoutes[kr]
    if (prodRoute) {
      try {
        const r = await prodRoute.exec(data)
        return { statusCode:200, headers:{'Content-Type':'application/json'}, body:JSON.stringify({ data: r.data, meta: { requestId:rid, credits:prodRoute.cr, action:'product_route' } }) }
      } catch(err) {
        return { statusCode:500, headers:{'Content-Type':'application/json'}, body:JSON.stringify(makeError(ERROR_CODES.PROVIDER_UNAVAILABLE,err.message,rid)) }
      }
    }
    return { statusCode:404, headers:{'Content-Type':'application/json'}, body:JSON.stringify(makeError(ERROR_CODES.INVALID_REQUEST,'Unknown: '+path,rid)) }
  }

  try {
    const r = await route.exec(data)
    return { statusCode: r.s, headers: { 'Content-Type':'application/json', 'x-tera-request-id':rid, 'x-tera-api-action':route.action, 'x-tera-credits-charged':String(route.cr) }, body: JSON.stringify(r.b) }
  } catch(err) {
    return { statusCode:500, headers:{'Content-Type':'application/json'}, body:JSON.stringify(makeError(ERROR_CODES.PROVIDER_UNAVAILABLE,err.message,rid)) }
  }
}
export { handler }
