import { flujoDesdeAsistente } from './asistente.service';

/**
 * La traducción del flujo que dicta el asistente al que entiende el proveedor.
 *
 * Es la única parte del asistente con lógica propia —lo demás lo decide el
 * modelo—, y es donde se rompen las dos cosas que ya nos costaron una ronda
 * cada una: el nodo de entrada tiene que llamarse `start_node`, y el orden de
 * las salidas de una fase no es cosmético.
 */
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
