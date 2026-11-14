import { Controller, Get, Inject } from '@nestjs/common';
import type { ClientConfig } from '@vizscript/api-contract';
import type { AppConfig } from './config';
import { APP_CONFIG } from './config';

/** Settings the web app needs before (or without) signing in. */
@Controller('config')
export class ConfigController {
  public constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  @Get()
  public get(): ClientConfig {
    return {
      github: {
        apiUrl: this.config.githubApiUrl,
        rawUrl: this.config.githubRawUrl,
      },
    };
  }
}
