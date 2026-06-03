import type { Logger } from "pino";
import type { ScraperModule, ScraperModuleConfig } from "./base.js";
import { AvtoNetModule } from "./avto-net/index.js";
import { BolhaModule } from "./bolha/index.js";
import { ProteiniSiModule } from "./proteini-si/index.js";

type ModuleFactory = (config: ScraperModuleConfig, logger: Logger) => ScraperModule;

const registry = new Map<string, ModuleFactory>();

function register(name: string, factory: ModuleFactory): void {
  registry.set(name, factory);
}

export function getModule(config: ScraperModuleConfig, logger: Logger): ScraperModule {
  const factory = registry.get(config.name);
  if (!factory) {
    throw new Error(
      `Unknown module: "${config.name}". Available modules: ${[...registry.keys()].join(", ")}`,
    );
  }
  return factory(config, logger);
}

export function getAvailableModules(): string[] {
  return [...registry.keys()];
}

// Register all modules
register("avto-net", (config, logger) => new AvtoNetModule(config, logger));
register("bolha", (config, logger) => new BolhaModule(config, logger));
register("proteini-si", (config, logger) => new ProteiniSiModule(config, logger));
