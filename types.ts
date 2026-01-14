
export interface ProductOffer {
  name: string;
  description: string;
  price: string;
  offer: string;
  targetCity: string;
}

export interface Lead {
  id: string;
  name: string;
  city: string;
  phone?: string;
  notes?: string;
  status: 'pending' | 'called' | 'interested' | 'not_interested';
  summary?: string;
}

export interface TranscriptionEntry {
  role: 'user' | 'agent';
  text: string;
  timestamp: number;
}

export enum CallStatus {
  IDLE = 'IDLE',
  DIALING = 'DIALING',
  ACTIVE = 'ACTIVE',
  ENDED = 'ENDED'
}
