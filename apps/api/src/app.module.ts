import type { DynamicModule } from '@nestjs/common';
import { Module } from '@nestjs/common';
import { AuthController } from './auth/auth.controller';
import { AuthService } from './auth/auth.service';
import { SessionGuard } from './auth/session.guard';
import type { AppConfig } from './config/config';
import { APP_CONFIG } from './config/config';
import { DatabaseModule } from './database/database.module';
import { HealthController } from './health/health.controller';
import { LayoutController } from './layout/layout.controller';
import { LayoutService } from './layout/layout.service';
import { PreferencesController } from './preferences/preferences.controller';
import { PreferencesService } from './preferences/preferences.service';
import { RecentController } from './recent/recent.controller';
import { RecentService } from './recent/recent.service';
import { GitHubProvider } from './scm/github.provider';
import type { ScmProvider } from './scm/scm-provider';
import { SCM_PROVIDERS } from './scm/scm-provider';
import { ScmController } from './scm/scm.controller';
import { ScmRegistry } from './scm/scm.registry';

@Module({})
export class AppModule {
  public static forRoot(
    config: AppConfig,
    overrides: { scmProviders?: ScmProvider[] } = {}
  ): DynamicModule {
    const configModule: DynamicModule = {
      module: class ConfigModule {},
      global: true,
      providers: [{ provide: APP_CONFIG, useValue: config }],
      exports: [APP_CONFIG],
    };

    return {
      module: AppModule,
      imports: [configModule, DatabaseModule],
      controllers: [
        AuthController,
        ScmController,
        LayoutController,
        PreferencesController,
        RecentController,
        HealthController,
      ],
      providers: [
        GitHubProvider,
        {
          provide: SCM_PROVIDERS,
          inject: [GitHubProvider],
          useFactory: (github: GitHubProvider): ScmProvider[] =>
            overrides.scmProviders ?? [github],
        },
        ScmRegistry,
        AuthService,
        SessionGuard,
        LayoutService,
        PreferencesService,
        RecentService,
      ],
    };
  }
}
