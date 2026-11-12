import 'reflect-metadata';
import fastifyCookie from '@fastify/cookie';
import { NestFactory } from '@nestjs/core';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { AppModule } from './app.module';
import type { AppConfig } from './config/config';
import type { ScmProvider } from './scm/scm-provider';

export async function createApp(
  config: AppConfig,
  options: { scmProviders?: ScmProvider[]; logger?: boolean } = {}
): Promise<NestFastifyApplication> {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule.forRoot(config, { scmProviders: options.scmProviders }),
    new FastifyAdapter({ trustProxy: true, bodyLimit: 5 * 1024 * 1024 }),
    { logger: options.logger === false ? false : ['log', 'warn', 'error'] }
  );
  await app.register(fastifyCookie);
  app.setGlobalPrefix('api');
  app.enableShutdownHooks();
  return app;
}
