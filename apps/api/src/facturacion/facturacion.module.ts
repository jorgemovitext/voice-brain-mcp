import { Module } from '@nestjs/common';
import { OrganizacionesService } from '../auth/organizaciones.service';
import { FacturacionController } from './facturacion.controller';
import { LimitesService } from './limites.service';
import { MedicionService } from './medicion.service';

/**
 * Lo que se cobra: la medición de cada mensaje, los planes y los topes.
 *
 * No importa ningún módulo de canales a propósito. Es al revés: los canales
 * importan esto, y el envoltorio que mide (`CanalMedido`) se arma allá. Si
 * la facturación conociera los canales tendríamos un ciclo —y, peor, dos
 * lugares desde donde se puede mandar un mensaje sin pasar por el cobro.
 */
@Module({
  controllers: [FacturacionController],
  providers: [
    MedicionService,
    LimitesService,
    // El plan vive en la organización; el servicio es sin estado y cada
    // módulo provee el suyo (igual que AgentesModule).
    OrganizacionesService,
  ],
  exports: [MedicionService, LimitesService],
})
export class FacturacionModule {}
