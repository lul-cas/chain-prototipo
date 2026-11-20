import { DatePipe } from '@angular/common';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ANA } from '../testing/session';
import { appConfig } from './app.config';

/** An instant shown as the pages show dates and times. */
@Component({ imports: [DatePipe], template: `{{ '2026-01-15T12:00:00Z' | date: 'dd/MM/yyyy HH:mm' }}` })
class When {}

describe('appConfig', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('shows dates and times in UTC−03:00 whatever the browser zone (ADR-0010 D8)', async () => {
    vi.stubEnv('TZ', 'Asia/Tokyo'); // a browser twelve hours ahead of UTC−03:00, whatever this machine's zone is
    TestBed.configureTestingModule({ providers: [appConfig.providers, provideHttpClientTesting()] });

    const fixture = TestBed.createComponent(When);
    TestBed.inject(HttpTestingController).expectOne('/api/auth/me').flush(ANA); // the app's initializer loads the session
    await fixture.whenStable();

    expect(fixture.nativeElement.textContent).toBe('15/01/2026 09:00');
  });
});
