import type { Functionz } from "../core/framework";
import { loadDefaultFunctions } from "./default/default_functions";
import { loadAIFunctions } from "./default/ai_functions";
import { loadOSFunctions } from "./default/os_functions";
import { loadCodeWritingFunctions } from "./drafts/code_writing";
import { loadSelfBuildFunctions } from "./drafts/self_build";
import { loadClassicAgents } from "./classic/task_agent";

export async function loadDefaultPacks(framework: Functionz): Promise<void> {
  loadDefaultFunctions(framework);
  loadAIFunctions(framework);
  loadOSFunctions(framework);
  loadCodeWritingFunctions(framework);
  loadSelfBuildFunctions(framework);
  loadClassicAgents(framework);
}

export async function loadPack(framework: Functionz, packNameOrPath: string): Promise<void> {
  const norm = packNameOrPath.toLowerCase().trim();

  if (norm === "default" || norm === "default/default_functions") {
    loadDefaultFunctions(framework);
  } else if (norm === "ai" || norm === "default/ai_functions") {
    loadAIFunctions(framework);
  } else if (norm === "os" || norm === "default/os_functions") {
    loadOSFunctions(framework);
  } else if (norm === "drafts/code_writing" || norm === "code_writing_functions" || norm === "drafts/code_writing_functions") {
    loadCodeWritingFunctions(framework);
  } else if (norm === "drafts/self_build" || norm === "self_build") {
    loadSelfBuildFunctions(framework);
  } else if (norm === "classic" || norm === "classic/task_agent") {
    loadClassicAgents(framework);
  } else if (norm === "all" || norm === "all_packs") {
    await loadDefaultPacks(framework);
  } else {
    // Try importing external module or relative path
    try {
      const mod = await import(packNameOrPath);
      if (typeof mod.default === "function") {
        await mod.default(framework);
      } else if (typeof mod.loadFunctions === "function") {
        await mod.loadFunctions(framework);
      }
    } catch (err: any) {
      console.warn(`[BabyAGI Pack Loader] Could not dynamically import pack '${packNameOrPath}': ${err.message}`);
    }
  }
}
