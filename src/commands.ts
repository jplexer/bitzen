export const commands = [
  {name:"help",description:"Show commands and shortcuts"},
  {name:"login",description:"Connect a provider account"},
  {name:"logout",description:"Disconnect the selected provider"},
  {name:"account",description:"List or switch saved ChatGPT accounts"},
  {name:"usage",description:"Manage ChatGPT plan usage"},
  {name:"model",description:"Choose Captain or Crewmate model"},
  {name:"models",description:"Open the model picker"},
  {name:"mode",description:"Switch Crew / single mode"},
  {name:"new",description:"Start a fresh task view"},
  {name:"clear",description:"Clear the current task view"},
  {name:"status",description:"Show account, models, and settings"},
  {name:"cost",description:"Show this task's cost and calls"},
  {name:"resume",description:"Resume a saved run"},
  {name:"details",description:"Toggle reasoning and tool details"},
  {name:"cancel",description:"Cancel the active task"},
  {name:"quit",description:"Exit Bitzen"},
];
export interface CommandSuggestion {value:string;description:string}
export function commandSuggestions(input:string, providers:string[] = ["openrouter"]): CommandSuggestion[] {
  if(!input.startsWith("/") || input.includes("\n"))return [];
  const match=/^\/([^\s]*)(?:\s+(.*))?$/.exec(input);if(!match)return [];
  if(match[2]===undefined)return commands.filter(command=>command.name.startsWith(match[1]!.toLowerCase())).map(command=>({value:`/${command.name}`,description:command.description}));
  const argumentsByCommand:Record<string,string[]>={model:["captain","crewmate"],mode:["crew","single"],login:providers,logout:providers,account:["new"]};
  const prefix=match[2];if(prefix.includes(" "))return [];
  return (argumentsByCommand[match[1]!]??[]).filter(value=>value.startsWith(prefix.toLowerCase())).map(value=>({value:`/${match[1]} ${value}`,description:commands.find(command=>command.name===match[1])?.description??""}));
}
