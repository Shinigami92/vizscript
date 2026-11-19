import {
  BadRequestException,
  Controller,
  Get,
  Inject,
  NotFoundException,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import type { TypeCacheStats } from '@vizscript/api-contract';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AppConfig } from '../config/config';
import { APP_CONFIG } from '../config/config';
import type { CachedType } from './type-cache.service';
import { TypeCacheService } from './type-cache.service';
import type { TypeSource } from './type-sources';
import {
  typeCrateSource,
  typeFileSource,
  typeListingSource,
  typePypiSource,
} from './type-sources';

/**
 * The type registry: library type files and listings by the paths jsDelivr
 * uses (`?path=npm/vue@3.5.45/dist/vue.d.ts`), from the server's cache.
 * Open to signed-out visitors (public files only), with a limit on what
 * one client can make the server fetch.
 */
@Controller('types')
export class TypesController {
  public constructor(
    @Inject(TypeCacheService) private readonly cache: TypeCacheService,
    @Inject(APP_CONFIG) private readonly config: AppConfig
  ) {}

  @Get()
  public async file(
    @Query('path') path: string | undefined,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply
  ): Promise<string> {
    const source = typeFileSource(path ?? '', this.config.typeUpstream);
    return this.serve(source, request, reply, 'text/plain; charset=utf-8');
  }

  @Get('listing')
  public async listing(
    @Query('path') path: string | undefined,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply
  ): Promise<string> {
    const source = typeListingSource(path ?? '', this.config.typeUpstream);
    return this.serve(source, request, reply, 'application/json');
  }

  /** A crate's public API as Rust declarations per module (JSON). */
  @Get('crate')
  public async crate(
    @Query('name') name: string | undefined,
    @Query('version') version: string | undefined,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply
  ): Promise<string> {
    const source = typeCrateSource(
      name ?? '',
      version ?? 'latest',
      this.config.typeUpstream
    );
    return this.serve(source, request, reply, 'application/json');
  }

  /** A Python package's typed files (`.pyi`, `py.typed` packages), JSON. */
  @Get('pypi')
  public async pypi(
    @Query('name') name: string | undefined,
    @Query('version') version: string | undefined,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply
  ): Promise<string> {
    const source = typePypiSource(
      name ?? '',
      version ?? 'latest',
      this.config.typeUpstream
    );
    return this.serve(source, request, reply, 'application/json');
  }

  @Get('stats')
  public stats(): Promise<TypeCacheStats> {
    return this.cache.stats();
  }

  private async serve(
    source: TypeSource | undefined,
    request: FastifyRequest,
    reply: FastifyReply,
    contentType: string
  ): Promise<string> {
    if (!source) {
      throw new BadRequestException('Not a library type file');
    }

    const found: CachedType = await this.cache.get(source, request.ip);
    reply.header(
      'cache-control',
      found.immutable
        ? 'public, max-age=31536000, immutable'
        : 'public, max-age=3600'
    );
    if (found.status === 404) {
      throw new NotFoundException('No such library file');
    }

    reply.header('content-type', contentType);
    return found.body;
  }
}
