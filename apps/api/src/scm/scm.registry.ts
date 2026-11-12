import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import type { ProviderId } from '@vizscript/api-contract';
import type { ScmProvider } from './scm-provider';
import { SCM_PROVIDERS } from './scm-provider';

@Injectable()
export class ScmRegistry {
  private readonly providers: Map<string, ScmProvider>;

  public constructor(@Inject(SCM_PROVIDERS) providers: ScmProvider[]) {
    this.providers = new Map(providers.map((p) => [p.id, p]));
  }

  public get(id: string): ScmProvider {
    const provider = this.providers.get(id);
    if (!provider) {
      throw new BadRequestException(`Unknown provider "${id}"`);
    }

    return provider;
  }

  public ids(): ProviderId[] {
    return [...this.providers.keys()] as ProviderId[];
  }
}
