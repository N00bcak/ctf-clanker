"""Seed a disposable CTFd 3.8.1 installation for ctfdImport.test.ts."""
import tempfile
from pathlib import Path
from CTFd import create_app
from CTFd.config import TestingConfig
from CTFd.models import db, Users, Challenges, ChallengeFiles
from CTFd.utils import set_config

root = Path(tempfile.mkdtemp(prefix="clanker-ctfd-"))


class Config(TestingConfig):
    SERVER_NAME = None
    TESTING = False
    DEBUG = False
    SAFE_MODE = False
    SQLALCHEMY_DATABASE_URI = f'sqlite:///{root / "ctfd.sqlite"}'
    UPLOAD_FOLDER = str(root / 'uploads')
    LOG_FOLDER = str(root / 'logs')

app = create_app(Config)
with app.app_context():
    set_config('setup', True)
    set_config('ctf_name', 'Clanker import fixture')
    set_config('user_mode', 'users')
    set_config('challenge_visibility', 'private')
    set_config('account_visibility', 'public')
    set_config('score_visibility', 'public')
    set_config('registration_visibility', 'public')
    set_config('ctf_theme', 'core')
    if not Users.query.filter_by(name='import-test').first():
        db.session.add(Users(name='import-test', email='import-test@example.test', password='local-fixture-password', verified=True))
        challenge = Challenges(name='Integration', description='CTFd integration fixture\n\n```python\nprint(42)\n```', category='misc', value=100, state='visible', type='standard', connection_info='nc localhost 9999')
        db.session.add(challenge)
        db.session.flush()
        location='fixture/handout.bin'
        target=Path(Config.UPLOAD_FOLDER)/location
        target.parent.mkdir(parents=True,exist_ok=True)
        target.write_bytes(bytes([0,255,42]))
        db.session.add(ChallengeFiles(challenge_id=challenge.id,location=location))
        db.session.commit()
app.run(host='127.0.0.1', port=18787, use_reloader=False)
