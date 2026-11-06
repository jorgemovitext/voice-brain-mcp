import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PGlite } from '@electric-sql/pglite';
import { Pool } from 'pg';
import { ensureSchema } from '../shared/database.module';
import { SettingsService } from '../shared/settings.service';
import { MedicionService } from '../facturacion/medicion.service';
import { OrganizacionesService } from '../auth/organizaciones.service';
import { PlataformaService } from './plataforma.service';
import { PlataformaGuard, SOLO_PLATAFORMA } from './plataforma.guard';

/*
 * El back-office es la ÚNICA parte del sistema que ve a todos los clientes
 * a la vez. O sea: es la única que puede romper el aislamiento que sostiene
 * todo lo demás. Por eso lo que se prueba acá no es que las cifras sumen,
 * sino quién puede verlas.
 */

function poolDe(db: PGlite): Pool {
  return {
    query: async (texto: string, params?: unknown[]) => {
      if (!params?.length) {
        const r = await db.exec(texto);
        return { rows: r[r.length - 1]?.rows ?? [], rowCount: r[r.length - 1]?.rows?.length ?? 0 };
      }
      return db.query(texto, params as never);
    },
  } as unknown as Pool;
}

function contextoDe(user?: { plataforma?: boolean }): ExecutionContext {
  return {
    getHandler: () => function h() {},
    getClass: () => class C {},
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  } as unknown as ExecutionContext;
}

function reflectorCon(exige: boolean): Reflector {
  return { getAllAndOverride: (k: string) => (k === SOLO_PLATAFORMA ? exige : undefined) } as never;
}

describe('La puerta del back-office', () => {
  it('deja pasar al equipo de la plataforma', () => {
    const guard = new PlataformaGuard(reflectorCon(true));
    expect(guard.canActivate(contextoDe({ plataforma: true }))).toBe(true);
  });

  it('NO deja pasar al administrador de un cliente', () => {
    /*
     * Es el caso que importa. Un administrador de cliente tiene todos los
     * permisos DE SU EMPRESA; esto es otra cosa, y si dependiera del rol le
     * bastaría con ascenderse a sí mismo desde la pantalla de equipo para
     * ver la facturación de la competencia.
     */
    const guard = new PlataformaGuard(reflectorCon(true));
    expect(() => guard.canActivate(contextoDe({ plataforma: false }))).toThrow(ForbiddenException);
    expect(() => guard.canActivate(contextoDe({}))).toThrow(ForbiddenException);
    expect(() => guard.canActivate(contextoDe(undefined))).toThrow(ForbiddenException);
  });

  it('no se mete en los endpoints que no son del back-office', () => {
    const guard = new PlataformaGuard(reflectorCon(false));
    expect(guard.canActivate(contextoDe(undefined))).toBe(true);
  });
});

describe('Lo que ve el dueño del servicio', () => {
  let db: PGlite;
  let pool: Pool;
  let plataforma: PlataformaService;
  let medicion: MedicionService;

  const settings = {
    get: async () => undefined,
    set: async (_k: string, v: unknown) => v,
  } as unknown as SettingsService;

  beforeAll(async () => {
    db = new PGlite();
    pool = poolDe(db);
    await ensureSchema(pool);

    const orgs = new OrganizacionesService(pool);
    medicion = new MedicionService(pool, settings);
    plataforma = new PlataformaService(pool, orgs, medicion);
  }, 30_000);

  afterAll(async () => {
    await db.close();
  });

  beforeEach(async () => {
    await db.exec(`TRUNCATE consumo; DELETE FROM users; DELETE FROM lineas;
                   DELETE FROM cuentas WHERE organizacion_id <> 'org-movitext';
                   DELETE FROM organizaciones WHERE id <> 'org-movitext';`);
  });

  /** Un cliente con su cuenta principal, como lo deja el alta real. */
  async function sembrarCliente(id: string, nombre: string) {
    await db.exec(`
      INSERT INTO organizaciones (id, nombre, plan, codigo, tipo)
        VALUES ('${id}', '${nombre}', 'negocio', 'C-${id}', 'cliente');
      INSERT INTO cuentas (id, organizacion_id, codigo, nombre)
        VALUES ('cta-${id}', '${id}', 'PRINCIPAL', 'Cuenta principal');
    `);
  }

  it('lista a cada cliente con su consumo y su margen', async () => {
    await sembrarCliente('org-clinica', 'Clinica San Jorge');
    await sembrarCliente('org-taller', 'Taller Mendoza');

    await medicion.registrar({ organizacion: 'org-clinica', destino: '+50433030235' });
    await medicion.registrar({ organizacion: 'org-clinica', destino: '+50433030236' });
    await medicion.registrar({ organizacion: 'org-taller', destino: '+5215512345678' });

    const lista = await plataforma.clientes();
    const clinica = lista.find((c) => c.id === 'org-clinica')!;
    const taller = lista.find((c) => c.id === 'org-taller')!;

    expect(clinica.mensajes).toBe(2);
    expect(taller.mensajes).toBe(1);
    // El margen es nuestro y sale de la fila, no de una estimación.
    expect(clinica.facturado).toBeGreaterThan(clinica.costo);
    expect(clinica.codigo).toBe('C-org-clinica');
  });

  it('la ficha abre la factura por país, canal y categoría', async () => {
    /*
     * Agrupar solo por país da un total correcto con un detalle que no
     * explica nada: el precio lo mueven las tres cosas juntas, y cuando un
     * cliente pregunta «¿por qué me cobraron esto?» hay que poder señalar
     * la fila.
     */
    await sembrarCliente('org-clinica', 'Clinica San Jorge');

    await medicion.registrar({ organizacion: 'org-clinica', destino: '+50433030235', categoria: 'servicio' });
    await medicion.registrar({ organizacion: 'org-clinica', destino: '+50433030236', categoria: 'marketing' });
    await medicion.registrar({ organizacion: 'org-clinica', destino: '+34600111222', categoria: 'servicio' });

    const ficha = await plataforma.cliente('org-clinica');

    expect(ficha!.porPais).toHaveLength(3);
    const hn = ficha!.porPais.filter((f) => f.pais === 'HN');
    expect(hn.map((f) => f.categoria).sort()).toEqual(['marketing', 'servicio']);
    // La promoción a Honduras cuesta más que la respuesta: si no, el
    // desglose por categoría no estaría sirviendo de nada.
    expect(hn.find((f) => f.categoria === 'marketing')!.facturado).toBeGreaterThan(
      hn.find((f) => f.categoria === 'servicio')!.facturado,
    );
    expect(ficha!.margen).toBe(ficha!.facturado - ficha!.costo);
  });

  it('el detalle trae las columnas con las que ya se factura hoy', async () => {
    /*
     * cliente / cuenta / prefijo / tipo / cantidad son las que ya existen en
     * el reporte de Movitext. El teléfono, el canal y los operadores son lo
     * que faltaba para poder auditar un número portado.
     */
    await sembrarCliente('org-clinica', 'Clinica San Jorge');
    await medicion.registrar({
      organizacion: 'org-clinica',
      destino: '+50433030235',
      proveedor: 'gupshup',
      operadorFinal: 'Tigo',
    });

    const [fila] = await plataforma.detalle('org-clinica', MedicionService.periodoDe());

    expect(fila).toMatchObject({
      cliente: 'Clinica San Jorge',
      clienteCodigo: 'C-org-clinica',
      cuenta: 'PRINCIPAL',
      canal: 'whatsapp',
      pais: 'HN',
      prefijo: '504',
      telefono: '+50433030235',
      tipo: 'servicio',
      cantidad: 1,
      proveedor: 'gupshup',
      operadorFinal: 'Tigo',
    });
  });

  it('un cliente que no existe no devuelve una ficha vacía', async () => {
    await expect(plataforma.cliente('org-inventada')).resolves.toBeNull();
  });
});
