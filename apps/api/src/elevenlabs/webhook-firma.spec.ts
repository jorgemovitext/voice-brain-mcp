import { createHmac } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { FastifyRequest } from 'fastify';
import { WebhookLogService } from '../shared/webhook-log.service';
import { ElevenLabsController } from './elevenlabs.controller';
import { ElevenLabsVozService } from './elevenlabs-voz.service';

/**
 * La firma del webhook de post-llamada.
 *
 * Esto rechazaba TODO en producción sin que se notara: `elevenlabs-signature`
 * es un HMAC —el mismo formato de Stripe y Svix— y se estaba comparando por
 * igualdad contra el secreto. Las llamadas ocurrían, el agente contestaba, y a
 * la app no llegaba ninguna: ni en Conversaciones ni en el tablero.
 *
 * Un webhook rechazado no se ve por ningún lado, así que la única forma de que
 * esto no vuelva a pasar en silencio es fijarlo acá.
 */
describe('Webhook de ElevenLabs · firma', () => {
  const SECRETO = 'wsec_de_prueba';
  const CUERPO = JSON.stringify({ type: 'post_call', data: { conversation_id: 'conv_1' } });

  function build(secreto = SECRETO) {
    const traidas: string[] = [];
    const registro: Array<{ resumen: string; ok: boolean }> = [];

    const voz = {
      traerTranscripcion: async (id: string) => {
        traidas.push(id);
        return { nuevos: 2 };
      },
    };
    const bitacora = {
      push: (_f: string, resumen: string, ok: boolean) => registro.push({ resumen, ok }),
      flush: async () => undefined,
    };

    const controller = new ElevenLabsController(
      voz as unknown as ElevenLabsVozService,
      bitacora as unknown as WebhookLogService,
      { get: (_k: string, d?: unknown) => secreto || d } as unknown as ConfigService,
    );
    return { controller, traidas, registro };
  }

  /** Una petición como la que manda ElevenLabs. */
  const pedido = (firma?: string, crudo: string = CUERPO) =>
    ({
      headers: firma ? { 'elevenlabs-signature': firma } : {},
      rawBody: Buffer.from(crudo, 'utf-8'),
    }) as unknown as FastifyRequest;

  /** La firma real: HMAC-SHA256 de `<t>.<cuerpo crudo>`. */
  const firmar = (t: string, crudo = CUERPO, secreto = SECRETO) =>
    `t=${t},v0=${createHmac('sha256', secreto).update(`${t}.${crudo}`).digest('hex')}`;

  it('acepta la firma HMAC que manda ElevenLabs', async () => {
    const { controller, traidas } = build();

    const r = await controller.cierre(JSON.parse(CUERPO), pedido(firmar('1788000000')));

    expect(r).toMatchObject({ received: true, nuevos: 2 });
    expect(traidas).toEqual(['conv_1']);
  });

  it('rechaza una firma de otro secreto', async () => {
    const { controller, traidas, registro } = build();

    const r = await controller.cierre(
      JSON.parse(CUERPO),
      pedido(firmar('1788000000', CUERPO, 'otro_secreto')),
    );

    expect(r).toMatchObject({ received: false });
    expect(traidas).toEqual([]);
    expect(registro[0].resumen).toContain('no coincide');
  });

  it('rechaza si el cuerpo fue alterado después de firmarlo', async () => {
    // El HMAC va sobre el cuerpo crudo justamente para esto.
    const { controller, traidas } = build();

    const r = await controller.cierre(
      JSON.parse(CUERPO),
      pedido(firmar('1788000000'), JSON.stringify({ type: 'post_call', data: { conversation_id: 'otra' } })),
    );

    expect(r).toMatchObject({ received: false });
    expect(traidas).toEqual([]);
  });

  it('dice POR QUÉ rechazó, no un "inválido" a secas', async () => {
    /*
     * "No llegó la cabecera" y "la firma no coincide" mandan a revisar cosas
     * distintas: la config del proveedor o el secreto. Sin el motivo, un
     * webhook rechazado es indistinguible de uno que nunca llegó.
     */
    const { controller, registro } = build();

    await controller.cierre(JSON.parse(CUERPO), pedido());
    await controller.cierre(JSON.parse(CUERPO), pedido('t=1,v0=nada'));

    expect(registro[0].resumen).toContain('sin cabecera de firma');
    expect(registro[1].resumen).toContain('no coincide');
  });

  it('sin secreto configurado no exige nada', async () => {
    // Fail-open: se empieza a exigir recién cuando está puesto de los dos lados.
    const { controller, traidas } = build('');

    const r = await controller.cierre(JSON.parse(CUERPO), pedido());

    expect(r).toMatchObject({ received: true });
    expect(traidas).toEqual(['conv_1']);
  });

  it('acepta también el secreto en crudo, para montajes que lo mandan así', async () => {
    const { controller, traidas } = build();

    const r = await controller.cierre(JSON.parse(CUERPO), pedido(SECRETO));

    expect(r).toMatchObject({ received: true });
    expect(traidas).toEqual(['conv_1']);
  });
});
