import { ConfigService } from '@nestjs/config';
import { AgenteActivoService } from '../shared/agente-activo.service';
import { AgentesService, AristaFlujo, NodoFlujo } from './agentes.service';
import { flujoDesdeAsistente } from './asistente.service';

/**
 * La traducción del flujo que dicta el asistente al que entiende el proveedor.
 *
 * Es la única parte del asistente con lógica propia —lo demás lo decide el
 * modelo—, y es donde se rompen las dos cosas que ya nos costaron una ronda
 * cada una: el nodo de entrada tiene que llamarse `start_node`, y el orden de
 * las salidas de una fase no es cosmético.
 */
/** Nadie eligió agente en la consola: nada está «en uso». */
const SIN_AGENTE_ACTIVO = { id: async () => '' } as unknown as AgenteActivoService;

describe('flujoDesdeAsistente', () => {
  const base = {
    fases: [
      { id: 'saludo', nombre: 'Saludo' },
      { id: 'emergencia', nombre: 'Emergencia' },
      { id: 'reporte', nombre: 'Reporte' },
      { id: 'cierre', nombre: 'Cierre', fin: true },
    ],
    salidas: [
      { desde: 'saludo', hasta: 'emergencia', condicion: 'hay alguien en peligro' },
      { desde: 'saludo', hasta: 'reporte', condicion: 'quiere reportar algo' },
      { desde: 'reporte', hasta: 'cierre' },
    ],
  };

  it('la primera fase se llama start_node, y las salidas la siguen', () => {
    /*
     * El proveedor rechaza el flujo con "Workflow must contain a start node"
     * si la entrada no se llama así. Y si solo se renombrara el nodo, las
     * aristas quedarían apuntando a una fase que ya no existe.
     */
    const { nodos, aristas } = flujoDesdeAsistente(base);

    expect(nodos[0].id).toBe('start_node');
    expect(nodos[0].tipo).toBe('inicio');
    expect(aristas.filter((a) => a.desde === 'start_node')).toHaveLength(2);
    expect(aristas.some((a) => a.desde === 'saludo')).toBe(false);
  });

  it('conserva el orden de evaluación de las salidas de una fase', () => {
    // Gana la primera condición que se cumple: si "quiere reportar algo" se
    // evaluara antes, una emergencia entraría por la rama tranquila.
    const { nodos, aristas } = flujoDesdeAsistente(base);

    const inicio = nodos.find((n) => n.id === 'start_node')!;
    const [primera, segunda] = inicio.orden!;
    expect(aristas.find((a) => a.id === primera)?.condicion).toBe('hay alguien en peligro');
    expect(aristas.find((a) => a.id === segunda)?.condicion).toBe('quiere reportar algo');
  });

  it('solo lleva orden la fase que se bifurca', () => {
    const { nodos } = flujoDesdeAsistente(base);
    expect(nodos.find((n) => n.id === 'reporte')?.orden).toBeUndefined();
  });

  it('la fase marcada como fin se marca como fin', () => {
    const { nodos } = flujoDesdeAsistente(base);
    expect(nodos.find((n) => n.id === 'cierre')?.tipo).toBe('fin');
  });

  it('las posiciones las pone la app, no el modelo', () => {
    // Pedirle coordenadas al modelo es pedirle que haga de tipógrafo: salían
    // nodos encimados. Acá ninguna fase comparte lugar con otra.
    const { nodos } = flujoDesdeAsistente(base);
    const lugares = new Set(nodos.map((n) => `${n.x},${n.y}`));
    expect(lugares.size).toBe(nodos.length);
  });

  it('descarta fases y salidas incompletas en vez de guardar basura', () => {
    const { nodos, aristas } = flujoDesdeAsistente({
      fases: [{ id: 'a', nombre: 'A' }, { nombre: 'sin id' }, { id: 'c' }],
      salidas: [{ desde: 'a' }, { desde: 'a', hasta: 'a' }],
    });

    expect(nodos.map((n) => n.id)).toEqual(['start_node']);
    expect(aristas).toHaveLength(1);
  });

  it('sin fases devuelve vacío, para que el llamador no guarde nada', () => {
    expect(flujoDesdeAsistente({}).nodos).toHaveLength(0);
  });
});

/**
 * Sumar UNA fase al flujo, que es como lo arma el constructor.
 *
 * El caso que importa es el agente recién creado: el proveedor lo entrega ya
 * con un `start_node` vacío y SIN salidas. Si la primera fase no se conecta a
 * él, la conversación arranca en un nodo que no lleva a ninguna parte y nada
 * falla visiblemente — el agente contesta con el prompt base y el flujo
 * dibujado es decorativo.
 */
describe('AgentesService.agregarFase', () => {
  let guardado: { nodos: NodoFlujo[]; aristas: AristaFlujo[] };

  /** Un servicio con el flujo que diga el caso, y el guardado interceptado. */
  function conFlujo(nodos: NodoFlujo[], aristas: AristaFlujo[] = []): AgentesService {
    const servicio = new AgentesService(
      { get: (_c: string, d?: string) => d ?? '' } as unknown as ConfigService,
      SIN_AGENTE_ACTIVO,
    );
    jest.spyOn(servicio, 'flujo').mockResolvedValue({ nodos, aristas });
    jest.spyOn(servicio, 'guardarFlujo').mockImplementation(async (_id, f) => {
      guardado = f;
    });
    return servicio;
  }

  const entrada: NodoFlujo = { id: 'start_node', tipo: 'inicio', nombre: 'inicio', x: 0, y: 0 };

  it('conecta la primera fase a la entrada que el proveedor ya sembró', async () => {
    const servicio = conFlujo([entrada]);

    const r = await servicio.agregarFase('ag-1', { id: 'fase_saludo', nombre: 'Saludo' });

    // Conserva el id del constructor: la entrada ya existe, no hay que
    // renombrar nada.
    expect(r.id).toBe('fase_saludo');
    expect(guardado.aristas).toEqual([
      { id: 'e1', desde: 'start_node', hasta: 'fase_saludo', condicion: '' },
    ]);
  });

  it('no vuelve a conectar la entrada si ya tiene una salida', async () => {
    const servicio = conFlujo(
      [entrada, { id: 'fase_saludo', tipo: 'fase', nombre: 'Saludo', x: 0, y: 0 }],
      [{ id: 'e1', desde: 'start_node', hasta: 'fase_saludo' }],
    );

    await servicio.agregarFase('ag-1', { id: 'fase_reporte', nombre: 'Reporte' });

    // Dos salidas incondicionales desde la entrada harían que gane la primera
    // siempre y la segunda fase quede inalcanzable.
    expect(guardado.aristas).toHaveLength(1);
  });

  it('sin nodo de entrada, la primera fase se renombra y pasa a ser la entrada', async () => {
    // Agentes de antes de que el proveedor sembrara el nodo: el flujo entero
    // se rechaza con "Workflow must contain a start node" si no hay entrada.
    const servicio = conFlujo([]);

    const r = await servicio.agregarFase('ag-1', { id: 'fase_saludo', nombre: 'Saludo' });

    expect(r.id).toBe('start_node');
    expect(guardado.nodos[0].tipo).toBe('inicio');
    expect(guardado.aristas).toHaveLength(0);
  });

  it('la fase marcada como fin no se confunde con la entrada', async () => {
    const servicio = conFlujo([entrada]);

    await servicio.agregarFase('ag-1', { id: 'fase_cierre', nombre: 'Cierre', fin: true });

    expect(guardado.nodos.find((n) => n.id === 'fase_cierre')?.tipo).toBe('fin');
  });

  it('una fase repetida no se agrega dos veces', async () => {
    const servicio = conFlujo([entrada, { id: 'fase_saludo', tipo: 'fase', nombre: 'S', x: 0, y: 0 }]);

    const r = await servicio.agregarFase('ag-1', { id: 'fase_saludo', nombre: 'Saludo otra vez' });

    expect(r.total).toBe(2);
    expect(guardado).toBeUndefined();
  });

  beforeEach(() => {
    guardado = undefined as unknown as typeof guardado;
  });
});
