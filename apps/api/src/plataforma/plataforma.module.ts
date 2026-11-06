import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { OrganizacionesService } from '../auth/organizaciones.service';
import { FacturacionModule } from '../facturacion/facturacion.module';
import { PlataformaController } from './plataforma.controller';
import { PlataformaGuard } from './plataforma.guard';
import { PlataformaService } from './plataforma.service';

/**
 * El back-office del dueño del servicio.
 *
 * El guard se registra como GLOBAL aunque solo lo use este módulo: así, un
 * controller nuevo que lleve `@SoloPlataforma` queda protegido viva donde
 * viva, sin tener que acordarse de registrarlo.
 */
@Module({
  imports: [FacturacionModule],
  controllers: [PlataformaController],
  providers: [
    PlataformaService,
    OrganizacionesService,
    { provide: APP_GUARD, useClass: PlataformaGuard },
  ],
  exports: [PlataformaService],
})
export class PlataformaModule {}
