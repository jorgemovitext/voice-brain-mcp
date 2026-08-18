import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { BRAIN_REPOSITORY, BrainRepository } from './brain.repository';
import { Contact } from './types';

export interface ResolveIdentityInput {
  phone?: string; // E.164
  externalId?: string;
  system?: string; // p. ej. "nlpearl", "sender" — default "nlpearl"
  displayName?: string; // opcional, para enriquecer al crear
}

export interface ResolveIdentityResult {
  contactId: string;
  created: boolean;
}

/**
 * Identidad unificada: NL Pearl llavea por teléfono/externalId;
 * acá se une esa llave al contactId propio. Si no existe, se crea.
 */
@Injectable()
export class IdentityService {
  constructor(@Inject(BRAIN_REPOSITORY) private readonly repo: BrainRepository) {}

  async resolveIdentity(input: ResolveIdentityInput): Promise<ResolveIdentityResult> {
    const system = input.system ?? 'nlpearl';

    // 1) Nuestro propio contactId puede venir como externalId (así lo mandamos en addLead)
    if (input.externalId) {
      const direct = await this.repo.getContact(input.externalId);
      if (direct) return { contactId: direct.id, created: false };
      const byExternal = await this.repo.findContactByExternalId(system, input.externalId);
      if (byExternal) return { contactId: byExternal.id, created: false };
    }

    // 2) Por teléfono E.164
    if (input.phone) {
      const byPhone = await this.repo.findContactByPhone(input.phone);
      if (byPhone) {
        // Aprendemos el externalId nuevo si vino
        if (input.externalId && !byPhone.externalIds[system]) {
          byPhone.externalIds[system] = input.externalId;
          await this.repo.saveContact(byPhone);
        }
        return { contactId: byPhone.id, created: false };
      }
    }

    // 3) No existe: crear contacto nuevo
    const contact: Contact = {
      id: randomUUID(),
      displayName: input.displayName,
      phones: input.phone ? [input.phone] : [],
      externalIds: input.externalId ? { [system]: input.externalId } : {},
      kycmStatus: 'unverified',
    };
    await this.repo.saveContact(contact);
    return { contactId: contact.id, created: true };
  }
}
