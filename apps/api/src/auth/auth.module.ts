import { Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { randomBytes } from 'crypto';
import { IntegrationsModule } from '../integrations/integrations.module';
import { AuthController } from './auth.controller';
import { AuthGuard } from './auth.guard';
import { AuthService } from './auth.service';
import { OtpSender } from './otp.sender';
import { JsonUsersRepository, PgUsersRepository, USERS_REPOSITORY } from './users.repository';

/**
 * Autenticación de la consola: register + login con OTP por WhatsApp y
 * sesión en cookie httpOnly. El AuthGuard se registra como APP_GUARD:
 * TODA la API exige sesión salvo lo marcado @Public().
 */
@Module({
  imports: [
    IntegrationsModule, // canal WhatsApp para entregar el OTP
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        let secret = config.get<string>('AUTH_JWT_SECRET', '');
        if (!secret) {
          // Fail-safe de desarrollo: secreto efímero por proceso. En
          // serverless esto invalida sesiones en cada cold start — prod
          // DEBE definir AUTH_JWT_SECRET.
          secret = randomBytes(32).toString('hex');
          new Logger('AuthModule').warn(
            'AUTH_JWT_SECRET no está definido: usando secreto efímero (las sesiones no sobreviven reinicios).',
          );
        }
        return {
          secret,
          signOptions: { expiresIn: `${config.get<number>('AUTH_SESSION_HOURS', 12)}h` },
        };
      },
    }),
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    OtpSender,
    PgUsersRepository,
    JsonUsersRepository,
    {
      // Igual que el Brain: Postgres si hay DATABASE_URL; archivo local solo dev.
      provide: USERS_REPOSITORY,
      inject: [ConfigService, PgUsersRepository, JsonUsersRepository],
      useFactory: (config: ConfigService, pg: PgUsersRepository, json: JsonUsersRepository) =>
        config.get<string>('DATABASE_URL') ? pg : json,
    },
    // Deny-by-default para toda la app.
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
  exports: [AuthService],
})
export class AuthModule {}
