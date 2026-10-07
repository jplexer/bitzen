import { expect, test } from "bun:test";
import { matchingModels, modelChoices, validModelId } from "../src/models.ts";
import { OpenRouter } from "../src/providers/openrouter.ts";
import { signal } from "./helpers.ts";

const credentials = {kind:"api-key" as const,getToken:async()=>"catalogue-test-key"};
const textModel = { id:"vendor/alpha",name:"Alpha",supported_parameters:["tools"],architecture:{input_modalities:["text","image"],output_modalities:["text"]},context_length:200000,pricing:{prompt:"0.000002",completion:"0.00001"} };

test("OpenRouter catalogue uses credential source and exposes only text/tool models with valid metadata",async()=>{
  const adapter=new OpenRouter(credentials,{baseUrl:"https://example.test/api",fetch:async(url,init)=>{
    expect(String(url)).toBe("https://example.test/api/models");
    expect(init?.method).toBe("GET");
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer catalogue-test-key");
    return Response.json({data:[textModel,textModel,
      {...textModel,id:"vendor/free",pricing:{prompt:"0",completion:"0"}},
      {...textModel,id:"vendor/unknown",context_length:-1,pricing:{prompt:"bad",completion:"Infinity"}},
      {...textModel,id:"vendor/no-tools",supported_parameters:[]},
      {...textModel,id:"vendor/images",architecture:{input_modalities:["text"],output_modalities:["image"]}},
      {...textModel,id:"vendor/malformed",architecture:{input_modalities:23,output_modalities:"text"}},null,
    ]});
  }});
  const models=await adapter.listModels(signal());
  expect(models.map(model=>model.id)).toEqual(["vendor/alpha","vendor/free","vendor/unknown"]);
  expect(models[0]).toEqual({id:"vendor/alpha",name:"Alpha",contextLength:200000,inputUsdPerMillion:2,outputUsdPerMillion:10});
  expect(models[1]?.inputUsdPerMillion).toBe(0);
  expect(models[2]?.contextLength).toBeUndefined();expect(models[2]?.outputUsdPerMillion).toBeUndefined();
});

test("catalogue failures redact credentials and malformed responses fail clearly",async()=>{
  const adapter=new OpenRouter(credentials,{fetch:async()=>Response.json({error:{message:"bad catalogue-test-key"}},{status:403})});
  let message="";
  try{await adapter.listModels(signal());}catch(error){message=String(error);}
  expect(message).toContain("HTTP 403");expect(message).not.toContain("catalogue-test-key");
  await expect(new OpenRouter(credentials,{fetch:async()=>Response.json({data:{}})}).listModels(signal())).rejects.toThrow("invalid model catalogue");
});

test("model choices retain configured IDs, merge metadata, and search across providers",()=>{
  const config={lead:{provider:"test",model:"old"},sidekick:{provider:"other",model:"cheap"},maxCalls:10,maxTurns:10,maxOutputTokens:1000};
  const choices=modelChoices(config,[{id:"cheap",name:"Worker Small",provider:"other"},{id:"large",name:"Reasoner Large",provider:"test"},{id:"large",name:"Other Large",provider:"other"}],"sidekick");
  expect(choices[0]?.name).toBe("Worker Small");expect(choices).toHaveLength(4);
  expect(matchingModels({role:"lead",choices,query:"test reasoner",index:0,loading:false,error:""}).map(model=>model.id)).toEqual(["large"]);
  expect(validModelId("vendor/model:free")).toBe(true);
  expect(validModelId(" vendor/model")).toBe(false);expect(validModelId("evil\x1b[2J")).toBe(false);
});
