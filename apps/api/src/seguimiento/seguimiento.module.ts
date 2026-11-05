import { Module } from '@nestjs/common';
import { OrganizacionesService } from '../auth/organizaciones.service';
import { BrainModule } from '../brain/brain.module';
import { FacturacionModule } from '../facturacion/facturacion.module';
import { IntegrationsModule } from '../integrations/integrations.module';
import { SeguimientoController } from './seguimiento.controller';
import { SeguimientoService } from './seguimiento.service';

/**
 * Seguimiento: lo que el agente manda sin que le escriban.
 *
 * Importa IntegrationsModule por el canal de WhatsApp, que ya viene envuelto
 * en la medición. Eso es a propósito: un seguimiento es la forma más fácil
 * de gastar plata del cliente, y tiene que pasar por el mismo cobro y los
 * mismos topes que todo lo demás.
 */
@Module({
  imports: [BrainModule, FacturacionModule, IntegrationsModule],
  controllers: [SeguimientoController],
  providers: [SeguimientoService, OrganizacionesService],
  exports: [SeguimientoService],
})
export class SeguimientoModule {}
