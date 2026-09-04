import { BadRequestException, Body, Controller, Get, Param, Post, Req } from '@nestjs/common';
import { FastifyRequest } from 'fastify';
import { AuthService } from '../auth/auth.service';
import { AtencionService } from '../shared/atencion.service';
import { EjecutarService } from './ejecutar.service';
import { ExpedienteService } from './expediente.service';
import { HandoffService } from './handoff.service';
import { NlpearlActivityStore } from './activity.store';
import { BrainService } from '../brain/brain.service';
import { AgenteToolsService } from '../elevenlabs/agente-tools.service';

/**
 * GET /api/contacts/:id/expediente — resumen real del hilo y su caso en el CRM.
 *
 * Va aparte del contexto porque cambia mucho menos: el contexto se sondea cada
 * pocos segundos y esto consulta HubSpot. La consola lo refresca cada varias
 * vueltas, no en cada una.
 */
@Controller('api/contacts')
export class ExpedienteController {
  constructor(
    private readonly expediente: ExpedienteService,
    private readonly atencion: AtencionService,
    private readonly ejecutor: EjecutarService,
    private readonly auth: AuthService,
    private readonly handoff: HandoffService,
    private readonly store: NlpearlActivityStore,
    private readonly brain: BrainService,
    private readonly herramientas: AgenteToolsService,
  ) {}

  @Get(':id/expediente')
  de(@Param('id') id: string) {
    return this.expediente.de(id);
  }

  /**
   * Tomar o soltar la conversación.
   *
   * El operador sale del token de sesión, no del cuerpo: quién atiende un
   * hilo no es algo que el cliente pueda declarar por su cuenta.
   */
  @Post(':id/atencion')
  async atender(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() req: FastifyRequest & { user?: { username?: string; sub?: string } },
  ) {
    const { tomar } = (body ?? {}) as { tomar?: unknown };
    if (typeof tomar !== 'boolean') {
      throw new BadRequestException('Falta `tomar` (true para tomarla, false para soltarla)');
    }
    if (!tomar) return this.atencion.liberar(id);

    const quien = await this.operador(req);
    const estado = await this.atencion.tomar(id, quien);

    /*
     * Tomar el hilo ES presentarse: si el operador tiene que acordarse de
     * saludar aparte, el ciudadano se queda esperando a alguien que ya lo
     * está leyendo. El saludo no puede tumbar la toma, así que su motivo
     * vuelve como aviso en vez de como error.
     */
    const { aviso } = await this.ejecutor.saludar(id, quien);
    return { ...estado, aviso };
  }

  /**
   * Nombre legible del operador. El `sub` del token es un UUID interno y en
   * la consola no se muestran identificadores, así que se resuelve contra la
   * cuenta: nombre, usuario o teléfono — lo primero que sirva para que otro
   * operador sepa quién tiene el hilo.
   */
  private async operador(
    req: FastifyRequest & { user?: { username?: string; sub?: string } },
  ): Promise<string> {
    const sub = req.user?.sub;
    if (!sub) throw new BadRequestException('No se pudo identificar al operador');
    try {
      const yo = await this.auth.me(sub);
      const nombre = yo.name?.trim() || yo.username?.trim() || yo.phone?.trim();
      if (nombre) return nombre;
    } catch {
      // Cuenta borrada o token viejo: mejor un genérico que un UUID.
    }
    return req.user?.username?.trim() || 'un operador';
  }

  /**
   * Pide tomar una conversación que TODAVÍA está corriendo.
   *
   * No la corta de inmediato: la API de NL Pearl no lo permite. Deja la
   * petición marcada y el siguiente avance del flujo se la lleva en
   * `forceHandoff`. El flujo tiene que estar preparado para leerla — hoy no
   * lo está, así que la respuesta lo dice con todas las letras en vez de
   * fingir que la conversación ya es tuya.
   */
  @Post(':id/takeover')
  async takeover(
    @Param('id') id: string,
    @Req() req: FastifyRequest & { user?: { username?: string; sub?: string } },
  ) {
    const quien = await this.operador(req);
    const ctx = await this.brain.getContext({ contactId: id });
    const tel = ctx.contact.phones?.[0];
    if (!tel) throw new BadRequestException('El contacto no tiene teléfono');

    // La conversación en curso es la del avance más reciente de ese número.
    const avances = await this.store.listActivity({ phone: tel, kind: 'progress', limit: 40 });
    const enCurso = avances
      .map((a) => (a.raw ?? {}) as { conversationId?: string })
      .reverse()
      .find((r) => r.conversationId)?.conversationId;

    if (!enCurso) {
      throw new BadRequestException('Esta conversación todavía no reportó ningún avance del flujo');
    }

    const peticion = await this.handoff.pedir(enCurso, quien);
    return {
      pedido: true,
      operador: peticion.operador,
      // Honestidad explícita: sin la transición en el flujo, esto no deriva.
      aviso:
        'La petición queda anotada y viaja en el siguiente avance del flujo. ' +
        'Para que NL Pearl derive de verdad, su flujo debe leer forceHandoff ' +
        'y transicionar a handoffNoEmergency.',
    };
  }

  /**
   * Ejecuta una de las acciones sugeridas. Solo con el hilo TOMADO: si lo
   * está atendiendo el agente, su flujo hace estas mismas cosas y ejecutarlas
   * acá crearía el ticket dos veces.
   */
  @Post(':id/acciones/:accion')
  async ejecutar(
    @Param('id') id: string,
    @Param('accion') accion: string,
    @Req() req: FastifyRequest & { user?: { username?: string; sub?: string } },
  ) {
    const quien = await this.operador(req);
    const { operador } = await this.atencion.de(id);
    if (!operador) {
      throw new BadRequestException('Tomá la conversación antes de ejecutar acciones');
    }

    /*
     * Se delega en las herramientas del agente en vez de tener una copia.
     *
     * La implementación vieja venía de NL Pearl: leía las variables de su flujo
     * —que con este agente no llegan, así que iban vacías— y mandaba el
     * pipeline con ids fijos que solo existen en el portal donde se
     * escribieron. "Avisar a la cuadrilla" ni siquiera tocaba HubSpot.
     *
     * Con una sola implementación, el botón y el agente hacen lo mismo: si uno
     * funciona el otro también, y los dos quedan en Actividad.
     */
    if (accion === 'crear-ticket' || accion === 'emergencia') {
      const r = await this.herramientas.ejecutarComoOperador(id, accion, quien);
      if (!r.ok) throw new BadRequestException(r.mensaje);
      return { ok: true, detalle: r.mensaje };
    }
    throw new BadRequestException(`Acción desconocida: ${accion}`);
  }
}
