import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/** Estado de una integración, sin exponer nunca el valor de los secretos. */
export interface IntegrationStatus {
  id: 'nlpearl' | 'whatsapp' | 'sms' | 'almacenamiento';
  name: string;
  kind: 'voice' | 'messaging' | 'datos';
  /** true si tiene todo lo necesario para operar de verdad. */
  connected: boolean;
  /** Modo efectivo: real | mock (voz) o cloud-api | stub (mensajería). */
  mode: string;
  /** Variables de entorno que faltan para conectarla. */
  missing: string[];
  /** Datos públicos útiles para configurar el proveedor (no secretos). */
  details: Record<string, string>;
}

@Injectable()
export class IntegrationsService {
  constructor(private readonly config: ConfigService) {}

  /** Postgres > Blob > archivo local, el mismo orden que elige el Brain. */
  private modoPersistencia(): string {
    if (this.config.get<string>('DATABASE_URL')) return 'postgres';
    if (this.config.get<string>('BLOB_READ_WRITE_TOKEN')) return 'vercel-blob';
    return 'archivo local';
  }

  private persistenciaCompartida(): boolean {
    return this.modoPersistencia() !== 'archivo local';
  }

  /**
   * Proveedor de WhatsApp efectivo. Gupshup tiene prioridad sobre la Cloud API
   * de Meta; si no hay ninguno completo, queda el stub que registra en el log.
   */
  whatsappProvider(): 'gupshup' | 'cloud-api' | 'stub' {
    if (this.missingGupshup().length === 0) return 'gupshup';
    if (this.missingCloudApi().length === 0) return 'cloud-api';
    return 'stub';
  }

  private missingGupshup(): string[] {
    return (['GUPSHUP_API_KEY', 'GUPSHUP_APP_NAME', 'GUPSHUP_SOURCE_NUMBER'] as const).filter(
      (key) => !this.config.get<string>(key),
    );
  }

  private missingCloudApi(): string[] {
    return (['WHATSAPP_PHONE_NUMBER_ID', 'WHATSAPP_TOKEN'] as const).filter(
      (key) => !this.config.get<string>(key),
    );
  }

  private missingNlpearl(): string[] {
    return (['NLPEARL_ACCOUNT_ID', 'NLPEARL_API_KEY', 'NLPEARL_PEARL_ID'] as const).filter(
      (key) => !this.config.get<string>(key),
    );
  }

  list(): IntegrationStatus[] {
    const base = this.config.get<string>('PUBLIC_BASE_URL', '');
    const mock = this.config.get<boolean>('MOCK', true);
    const missingNlpearl = this.missingNlpearl();
    const provider = this.whatsappProvider();
    const whatsappOk = provider !== 'stub';

    return [
      {
        id: 'nlpearl',
        name: 'NL Pearl · Voz',
        kind: 'voice',
        connected: !mock && missingNlpearl.length === 0,
        mode: mock ? 'mock' : 'real',
        missing: mock ? [] : missingNlpearl,
        details: {
          'Webhook de llamada': `${base}/webhooks/nlpearl`,
          'Nodo PreCallAPI': `${base}/precall`,
          'Credencial del webhook': this.config.get<string>('NLPEARL_WEBHOOK_SECRET')
            ? 'configurada'
            : 'sin exigir (opcional)',
        },
      },
      {
        id: 'whatsapp',
        name:
          provider === 'gupshup'
            ? 'WhatsApp · Gupshup'
            : provider === 'cloud-api'
              ? 'WhatsApp · Cloud API (Meta)'
              : 'WhatsApp · sin proveedor',
        kind: 'messaging',
        connected: whatsappOk,
        mode: provider,
        // Basta con completar UNO de los dos proveedores; se muestra el preferido.
        missing: whatsappOk ? [] : this.missingGupshup(),
        details:
          provider === 'cloud-api'
            ? {
                'Callback URL (Meta)': `${base}/webhooks/whatsapp`,
                'Verify token': this.config.get<string>('WHATSAPP_VERIFY_TOKEN')
                  ? 'configurado'
                  : 'falta WHATSAPP_VERIFY_TOKEN',
                'Firma de eventos': this.config.get<string>('WHATSAPP_APP_SECRET')
                  ? 'validada (App Secret)'
                  : 'sin validar (falta WHATSAPP_APP_SECRET)',
                'Número emisor (ID)': this.config.get<string>('WHATSAPP_PHONE_NUMBER_ID') || '—',
              }
            : {
                'Callback URL (Gupshup)': `${base}/webhooks/gupshup`,
                'App de Gupshup': this.config.get<string>('GUPSHUP_APP_NAME') || '—',
                'Número emisor': this.config.get<string>('GUPSHUP_SOURCE_NUMBER') || '—',
                'API key': this.config.get<string>('GUPSHUP_API_KEY') ? 'configurada' : 'falta GUPSHUP_API_KEY',
                /*
                 * Sin plantilla no se puede iniciar una conversación: el
                 * ciudadano le escribe al número de NL Pearl, así que la
                 * ventana de 24 h nunca se abre con el nuestro. Se dice si
                 * está o no, nunca el id.
                 */
                /*
                 * Sin nombrar la plantilla: la app solo conoce su ID, y el
                 * nombre escrito a mano acá quedó desactualizado al primer
                 * cambio de plantilla. Se dice si está o no, nada más.
                 */
                'Plantilla de saludo': this.config.get<string>('GUPSHUP_TEMPLATE_SALUDO')
                  ? 'configurada'
                  : 'falta GUPSHUP_TEMPLATE_SALUDO — no se puede iniciar conversación',
                'Alternativa (Meta directo)': `${base}/webhooks/whatsapp`,
              },
      },
      {
        /*
         * Dónde vive el estado. Va acá porque "se me pierden las
         * conversaciones" y "el almacén es efímero" son el mismo problema
         * visto desde dos lados, y desde la consola no había forma de
         * distinguirlos sin abrir un endpoint a mano.
         */
        id: 'almacenamiento',
        name: 'Persistencia',
        kind: 'datos',
        connected: this.persistenciaCompartida(),
        mode: this.modoPersistencia(),
        missing: this.persistenciaCompartida() ? [] : ['DATABASE_URL'],
        details: {
          Estado: this.persistenciaCompartida()
            ? 'compartida: sobrevive a los despliegues y a varias instancias'
            : 'EFÍMERA: el estado vive en /tmp y se pierde entre instancias',
        },
      },
      {
        id: 'sms',
        name: 'SMS · Proveedor propio',
        kind: 'messaging',
        connected: false,
        mode: 'stub',
        missing: [],
        details: { Estado: 'Stub: registra el envío en el log, sin proveedor conectado' },
      },
    ];
  }
}
