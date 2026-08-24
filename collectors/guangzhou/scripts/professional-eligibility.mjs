/** Qualification gate: pure computing needs a biomedical bridge; other duties only rank jobs. */
const EXPLICIT_EXCLUSION = /(生物医学工程|生物医工|医学工程)(?:专业)?(?:除外|不(?:予|可|得)?报考|不接受|不招收)/i;
const OPEN_MAJOR = /(专业不限|不限专业|不限制专业|专业不作限制|可不限专业|不设专业限制|不限所学专业)/i;
const EXACT_MAJOR = /(生物医学工程|生物医工|医学工程|医疗器械工程|临床工程|医疗电子|医学影像工程)/i;
const ADJACENT_MAJOR = /(生物工程|生物技术|生物医药|生命科学|生物科学|生物类|医疗器械(?:类|工程|相关专业)?)/i;
const BROAD_ENGINEERING = /(?:^|[；;、，,\s/（(])(?:工学(?:门类|全类|大类|类|专业)?|所有工学|理工(?:科|类|专业|背景|方向)|工程(?:类|门类|学科))(?=$|[；;、，,\s/）)及等])/i;
const HEALTH_ROLE = /(医疗器械|医疗设备|医用耗材|医学影像|临床工程|体外诊断|生物信号|医疗健康|智慧医疗|医学数据|生物医药|生命科学|健康科技)/i;
const PURE_COMPUTING_ROLE = /(网络安全|信息安全|前端|后端|软件(?:开发|工程师|工程)|算法工程师|人工智能工程师|AI工程师|大模型|云计算|数据(?:开发|工程师)|程序员)/i;
const BIOMEDICAL_ROLE_BRIDGE = /(生物医学|医疗器械|医疗设备|医学影像|临床工程|体外诊断|IVD|生物信号|医学数据|智慧医疗|医疗软件|健康科技|生命科学)/i;
const OBJECTIVE_RISK = /(井下|矿山|海上作业|爆破|高海拔|有害暴露|长期夜班|长期倒班|长期驻外|高频出差|重体力)/i;
const normalize = (value) => (Array.isArray(value) ? value.join("；") : String(value || "")).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
const evidence = (pattern, text) => text.match(pattern)?.[0] || null;
export function evaluateProfessionalEligibility(value) { const text=normalize(value); if(!text)return{eligible:false,basis:"missing",evidence:null,reason:"官方任职条件未给出可核验的专业口径"}; if(EXPLICIT_EXCLUSION.test(text))return{eligible:false,basis:"excluded",evidence:evidence(EXPLICIT_EXCLUSION,text),reason:"官方条件明确排除生物医学工程相关专业"}; for(const [pattern,basis,reason] of [[OPEN_MAJOR,"open","官方条件明确不限专业"],[EXACT_MAJOR,"exact","官方条件明确列出生物医学工程或等同专业"],[ADJACENT_MAJOR,"adjacent","官方条件列出与生物医学工程相近的生物工程或医疗器械专业口径"],[BROAD_ENGINEERING,"broad-engineering","官方条件明确接受工学、理工或相近工程门类"]]){const matched=evidence(pattern,text);if(matched)return{eligible:true,basis,evidence:matched,reason};} return{eligible:false,basis:"unmatched",evidence:null,reason:"官方专业要求未覆盖生物医学工程或可报的相近门类"}; }
export function mastersEducationEligible(value){const text=normalize(value);return !/博士后/.test(text)&&!(/博士(?:研究生)?(?:及以上)?/.test(text)&&!/(本科|硕士|研究生及以上)/.test(text));}
export function roleIsProfileRelevant(value){const role=normalize(value);return !PURE_COMPUTING_ROLE.test(role)||BIOMEDICAL_ROLE_BRIDGE.test(role);}
export function rankProfessionalOpportunity(eligibility,roleValue){const base={exact:86,adjacent:78,"broad-engineering":70,open:60}[eligibility?.basis]||50,role=normalize(roleValue);return Math.max(35,Math.min(98,base+(HEALTH_ROLE.test(role)?7:0)-(OBJECTIVE_RISK.test(role)?18:0)));}
export function matchLevelForPriority(priority,eligibility){if(priority>=90)return"高度匹配";if(priority>=78)return"重点关注";if(eligibility?.basis==="open")return"专业不限";return"专业可报";}
export function objectiveRiskFlags(value){const text=normalize(value);return[...new Set([...text.matchAll(new RegExp(OBJECTIVE_RISK.source,"gi"))].map((match)=>match[0]))];}
export function professionalEligibilityPatterns(){return{open:OPEN_MAJOR,exact:EXACT_MAJOR,adjacent:ADJACENT_MAJOR,broadEngineering:BROAD_ENGINEERING};}
