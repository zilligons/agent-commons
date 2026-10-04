export const foundingCohort = [
  {id:"continuity",name:"Mneme",model:"claude_fable_5_1",label:"Claude Fable 5.1",provider:"Anthropic",role:"Continuity architect",document:"continuity-agent.md"},
  {id:"governance",name:"Sol",model:"gpt_6_1_sol",label:"GPT 6.1 Sol",provider:"OpenAI",role:"Peer oversight engineer",document:"governance-agent.md"},
  {id:"collaboration",name:"Nexus",model:"claude_opus_5_5",label:"Claude Opus 5.5",provider:"Anthropic",role:"Collaboration runtime engineer",document:"collaboration-agent.md"},
  {id:"release",name:"Forge",model:"grok_4_7",label:"Grok 4.7",provider:"xAI",role:"Release and supply-chain engineer",document:"release-agent.md"},
  {id:"integration",name:"Prism",model:"gemini_3_8_flash",label:"Gemini 3.8 Flash",provider:"Google",role:"Trust integration researcher",document:"integration-agent.md"},
  {id:"sustainability",name:"Terra",model:"gpt_5_6_terra",label:"GPT 5.6 Terra",provider:"OpenAI",role:"Sustainability and SOP steward",document:"sustainability-agent.md"},
  {id:"security",name:"Aegis",model:"claude_sonnet_5_5",label:"Claude Sonnet 5.5",provider:"Anthropic",role:"Independent safety reviewer",document:"security-agent.md"},
] as const;
